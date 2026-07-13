import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeStableId, readUsbIdentity } from "./cameraIdentity";
import { normalizeCameraFormats, normalizeCameraInputFormat, preferredCameraMode, type CameraFormat, type CameraFormatResolution } from "./cameraModes";
export type { CameraFormat, CameraFormatResolution } from "./cameraModes";

export type LocalCamera = {
  name: string;
  device: string;
  supportsCapture: boolean;
  /** Stable USB-based identity, when Linux exposes enough information to compute one. */
  stableId: string | null;
  /** Other /dev/video* nodes that expose the same physical camera identity. Diagnostic only. */
  alternateDevices?: Array<{ device: string; supportsCapture: boolean; reason?: string }>;
  /** Formats for the selected primary capture device. */
  formats?: CameraFormat[];
  /**
   * Part 5: whether a real, short ffmpeg one-frame capture actually
   * succeeded on this device - never assume reported V4L2 capabilities
   * ("Video Capture" in `--all`) mean a device can actually be opened for
   * streaming. The real bokchoy failure: two /dev/video* nodes shared one
   * physical camera and one USB identity; both reported "Video Capture"
   * in v4l2-ctl's aggregate Capabilities block, but only one could
   * actually be opened by ffmpeg (`VIDIOC_G_INPUT: Inappropriate ioctl
   * for device` on the other) - metadata alone could not tell them apart.
   */
  verifiedCapture?: boolean;
  /** The exact pixel format/resolution the real capture probe succeeded with - Part 6: never offer/assign a format+resolution combination that was never actually proven to work. Null/absent when verifiedCapture is not true. */
  verifiedFormat?: { pixelFormat: string; width: number; height: number } | null;
  /** Human-readable reason the probe failed, when verifiedCapture is false and at least one probe attempt was made. */
  captureProbeError?: string | null;
};

export type CameraControl = {
  id: string;
  name: string;
  type: "int" | "bool" | "menu" | "unknown";
  value: number | boolean | string;
  minimum?: number;
  maximum?: number;
  step?: number;
  defaultValue?: number | boolean | string;
  /** The driver reports this control as permanently non-writable. */
  readOnly: boolean;
  /**
   * The driver reports this control as temporarily non-writable because a
   * related automatic mode is currently controlling it (e.g. manual focus
   * while continuous autofocus is on). Unlike readOnly, this can change as
   * soon as the related control changes - reload controls after any write.
   */
  inactive: boolean;
  options?: Array<{ value: number; label: string }>;
};

function execFileText(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.toString().trim() || error.message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
        return;
      }

      resolve(stdout.toString());
    });
  });
}

export async function discoverLocalCameras(): Promise<LocalCamera[]> {
  const output = await execFileText("v4l2-ctl", ["--list-devices"]);
  const rawCameras: LocalCamera[] = [];
  let currentName = "Unknown camera";

  for (const line of output.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    if (!line.startsWith("\t") && !line.startsWith(" ")) {
      currentName = line.replace(/\s+\([^)]*\):$/, "").replace(/:$/, "").trim();
      continue;
    }

    const device = line.trim();
    if (!device.startsWith("/dev/video")) {
      continue;
    }

    const supportsCapture = await deviceSupportsCapture(device).catch(() => false);
    const stableId = await readUsbIdentity(device)
      .then((identity) => composeStableId(identity))
      .catch(() => null);
    const formats = supportsCapture ? await listCameraFormats(device).catch(() => []) : [];
    rawCameras.push({ name: currentName, device, supportsCapture, stableId, formats });
  }

  const verified = await verifyCameraGroups(rawCameras);
  return verified.sort((a, b) => {
    if (a.verifiedCapture !== b.verifiedCapture) {
      return a.verifiedCapture ? -1 : 1;
    }
    if (a.supportsCapture !== b.supportsCapture) {
      return a.supportsCapture ? -1 : 1;
    }

    return a.device.localeCompare(b.device, undefined, { numeric: true });
  });
}

/**
 * Part 5: real verified-capture selection, replacing metadata-only
 * primary-device selection. Groups by the same stable-identity key as
 * groupPhysicalCameras() (kept separately as a pure/sync function for its
 * own tests), then - one device at a time, serialized - performs a real
 * short ffmpeg one-frame capture probe against each metadata-plausible
 * candidate in score order, stopping at the first one that actually
 * succeeds. That device becomes primary; every other device in the group
 * is recorded as an alternate, annotated with its real probe outcome when
 * one was attempted.
 */
async function verifyCameraGroups(cameras: LocalCamera[]): Promise<LocalCamera[]> {
  const groups = new Map<string, LocalCamera[]>();
  for (const camera of cameras) {
    const key = camera.stableId ?? `device:${camera.device}`;
    groups.set(key, [...(groups.get(key) ?? []), camera]);
  }

  const result: LocalCamera[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (a, b) => scoreCameraNode(b) - scoreCameraNode(a) || a.device.localeCompare(b.device, undefined, { numeric: true }),
    );

    // Deliberately probes every metadata-plausible candidate in the group
    // (serialized, never in parallel) rather than stopping at the first
    // success - a failed alternate's exact reason (e.g. "VIDIOC_G_INPUT
    // inappropriate ioctl") is real diagnostic information the task
    // explicitly wants surfaced, not just "not probed."
    let winner: LocalCamera | null = null;
    const attempts = new Map<string, { ok: boolean; detail: string; format?: ProbeFormatCandidate }>();

    for (const candidate of ordered) {
      if (!candidate.supportsCapture) continue; // metadata already says no - not worth a real probe
      const probe = await probeDeviceCapture(candidate.device, candidate.formats ?? []);
      attempts.set(candidate.device, probe);
      if (probe.ok && !winner) {
        winner = {
          ...candidate,
          verifiedCapture: true,
          verifiedFormat: probe.format ?? null,
          captureProbeError: null,
        };
      }
    }

    const primaryBase = winner ?? ordered[0];
    const primary: LocalCamera =
      winner ??
      {
        ...primaryBase,
        verifiedCapture: false,
        verifiedFormat: null,
        captureProbeError: attempts.get(primaryBase.device)?.detail ?? null,
      };

    const alternateDevices = ordered
      .filter((camera) => camera.device !== primary.device)
      .map((camera) => {
        const attempt = attempts.get(camera.device);
        const reason = attempt
          ? attempt.ok
            ? "alternate capture node"
            : `Capture probe failed: ${attempt.detail}`
          : camera.supportsCapture
            ? "alternate capture node"
            : "not capture-capable";
        return { device: camera.device, supportsCapture: camera.supportsCapture, reason };
      });

    result.push({ ...primary, alternateDevices });
  }
  return result;
}

type ProbeFormatCandidate = { pixelFormat: string; width: number; height: number };

/** Prefers MJPEG at the highest reported resolution, always with a conservative 640x480 fallback candidate for devices with no reported formats or whose reported resolution doesn't actually work. */
function buildProbeCandidates(formats: CameraFormat[]): ProbeFormatCandidate[] {
  const candidates: ProbeFormatCandidate[] = [];
  const preferred = preferredCameraMode(formats);
  if (preferred) {
    candidates.push({ pixelFormat: preferred.inputFormat, width: preferred.width, height: preferred.height });
  }
  const isConservativeFallbackDuplicate = candidates.some((c) => c.width === 640 && c.height === 480);
  if (!isConservativeFallbackDuplicate) {
    candidates.push({ pixelFormat: "mjpeg", width: 640, height: 480 });
  }
  return candidates;
}

const CAPTURE_PROBE_TIMEOUT_MS = 8_000;

/** Tries each candidate format/resolution in order, stopping at the first real success - Part 5 point 4 ("choose one conservative supported format and resolution") plus point 8's 640x480 fallback. */
async function probeDeviceCapture(
  device: string,
  formats: CameraFormat[],
): Promise<{ ok: boolean; detail: string; format?: ProbeFormatCandidate }> {
  const candidates = buildProbeCandidates(formats);
  let lastDetail = "No capture candidates were available to probe.";
  for (const candidate of candidates) {
    const attempt = await attemptOneFrameCapture(device, candidate);
    if (attempt.ok) {
      return { ok: true, detail: attempt.detail, format: candidate };
    }
    lastDetail = attempt.detail;
  }
  return { ok: false, detail: lastDetail };
}

/** One real, short, serialized ffmpeg capture into a throwaway temp file - never canonical project/capture data, always cleaned up, always externally timed out in case the device hangs rather than erroring quickly. */
async function attemptOneFrameCapture(device: string, candidate: ProbeFormatCandidate): Promise<{ ok: boolean; detail: string }> {
  const tmpFile = path.join(os.tmpdir(), `plantlab-capture-probe-${randomUUID()}.jpg`);
  try {
    await runProbeFfmpeg(device, candidate, tmpFile);
    const info = await stat(tmpFile).catch(() => null);
    if (!info || info.size === 0) {
      return { ok: false, detail: "ffmpeg reported success but produced an empty or missing file." };
    }
    const head = await readFile(tmpFile)
      .then((buffer) => buffer.subarray(0, 2))
      .catch(() => Buffer.alloc(0));
    if (head.length < 2 || head[0] !== 0xff || head[1] !== 0xd8) {
      return { ok: false, detail: "Output file does not look like a valid JPEG." };
    }
    return { ok: true, detail: `Verified ${candidate.width}x${candidate.height} ${candidate.pixelFormat.toUpperCase()} capture.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

function runProbeFfmpeg(device: string, candidate: ProbeFormatCandidate, outputPath: string): Promise<void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "v4l2",
    "-input_format",
    normalizeCameraInputFormat(candidate.pixelFormat),
    "-video_size",
    `${candidate.width}x${candidate.height}`,
    "-i",
    device,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    outputPath,
  ];
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { shell: false });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg capture probe on ${device} timed out after ${CAPTURE_PROBE_TIMEOUT_MS}ms.`));
    }, CAPTURE_PROBE_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start ffmpeg: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

export function groupPhysicalCameras(cameras: LocalCamera[]): LocalCamera[] {
  const groups = new Map<string, LocalCamera[]>();
  for (const camera of cameras) {
    const key = camera.stableId ?? `device:${camera.device}`;
    groups.set(key, [...(groups.get(key) ?? []), camera]);
  }

  const result: LocalCamera[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => scoreCameraNode(b) - scoreCameraNode(a) || a.device.localeCompare(b.device, undefined, { numeric: true }));
    const primary = sorted[0];
    result.push({
      ...primary,
      alternateDevices: sorted.slice(1).map((camera) => ({
        device: camera.device,
        supportsCapture: camera.supportsCapture,
        reason: camera.supportsCapture ? "alternate capture node" : "not capture-capable",
      })),
    });
  }
  return result;
}

function scoreCameraNode(camera: LocalCamera): number {
  let score = 0;
  if (camera.supportsCapture) score += 10;
  if ((camera.formats ?? []).some((format) => format.resolutions.length > 0)) score += 20;
  return score;
}

/**
 * Extracts just the capability names listed under a "Device Caps" or
 * "Capabilities" block in `v4l2-ctl --all` output (each capability is a
 * line indented one level deeper than the block's own header line, e.g.
 * "\tDevice Caps      : 0x04200001\n\t\tVideo Capture\n\t\tStreaming").
 * Returns null when that block isn't present at all.
 */
function extractCapsBlock(output: string, label: "Device Caps" | "Capabilities"): string | null {
  const lines = output.split("\n");
  const headerIndex = lines.findIndex((line) => new RegExp(`^\\t${label}\\s*:`).test(line));
  if (headerIndex === -1) return null;
  const collected: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (!/^\t\t\S/.test(lines[i])) break;
    collected.push(lines[i].trim());
  }
  return collected.join("\n");
}

/**
 * Pure, hardware-free so it can be unit tested with recorded `v4l2-ctl -d
 * <device> --all` output. Only the "Device Caps" block (falling back to
 * the aggregate "Capabilities" block when absent) reflects a node's real
 * functional capability - `--all` also prints a "Format Video Capture
 * Multiplanar:" *section header* for the current format of a
 * memory-to-memory device's queue (e.g. a Raspberry Pi's
 * bcm2835-codec-decode/isp hardware), which contains the literal substring
 * "Video Capture" even though the device cannot actually capture from a
 * sensor - a naive whole-output substring match incorrectly treated every
 * one of those as a real camera.
 */
export function capsIndicateVideoCapture(v4l2CtlAllOutput: string): boolean {
  const capsBlock = extractCapsBlock(v4l2CtlAllOutput, "Device Caps") ?? extractCapsBlock(v4l2CtlAllOutput, "Capabilities");
  if (!capsBlock) return false;
  if (/Memory-to-Memory/i.test(capsBlock)) return false;
  return /Video Capture/.test(capsBlock);
}

async function deviceSupportsCapture(device: string) {
  const output = await execFileText("v4l2-ctl", ["-d", device, "--all"]);
  return capsIndicateVideoCapture(output);
}

/**
 * Parses the text output of `v4l2-ctl -d <device> --list-ctrls-menus`.
 * Pure and hardware-free so it can be unit tested with recorded output.
 */
export function parseControlsOutput(output: string): CameraControl[] {
  const controls: CameraControl[] = [];
  let currentMenuControl: CameraControl | null = null;

  for (const line of output.split("\n")) {
    const controlMatch = /^\s*([a-zA-Z0-9_]+)\s+0x[0-9a-fA-F]+\s+\(([^)]+)\)\s*:\s*(.*)$/.exec(line);
    const menuOptionMatch = /^\s+(\d+):\s*(.+)$/.exec(line);

    if (controlMatch) {
      const [, id, rawType, rawMeta] = controlMatch;
      const type = rawType === "integer" ? "int" : rawType === "boolean" ? "bool" : rawType === "menu" ? "menu" : "unknown";
      const meta = parseControlMeta(rawMeta);
      const value = type === "bool" ? meta.value === 1 : meta.value ?? "";
      const defaultValue = type === "bool" ? meta.defaultValue === 1 : meta.defaultValue;
      const flags = parseControlFlags(rawMeta);
      const control: CameraControl = {
        id,
        name: humanizeControlName(id),
        type,
        value,
        minimum: meta.minimum,
        maximum: meta.maximum,
        step: meta.step,
        defaultValue,
        readOnly: flags.readOnly,
        inactive: flags.inactive,
        options: type === "menu" ? [] : undefined,
      };

      controls.push(control);
      currentMenuControl = type === "menu" ? control : null;
      continue;
    }

    if (menuOptionMatch && currentMenuControl?.options) {
      currentMenuControl.options.push({
        value: Number(menuOptionMatch[1]),
        label: menuOptionMatch[2].trim(),
      });
    }
  }

  return controls;
}

export async function listCameraControls(device: string): Promise<CameraControl[]> {
  const output = await execFileText("v4l2-ctl", ["-d", device, "--list-ctrls-menus"]);
  return parseControlsOutput(output);
}

export async function listCameraFormats(device: string): Promise<CameraFormat[]> {
  const output = await execFileText("v4l2-ctl", ["-d", device, "--list-formats-ext"]);
  return parseCameraFormatsOutput(output);
}

export function parseCameraFormatsOutput(output: string): CameraFormat[] {
  const formats: CameraFormat[] = [];
  let currentFormat: CameraFormat | null = null;
  let currentResolution: CameraFormatResolution | null = null;

  for (const line of output.split("\n")) {
    const formatMatch = /\[\d+\]:\s+'([^']+)'\s+\(([^)]+)\)/.exec(line);
    const sizeMatch = /Size:\s+Discrete\s+(\d+)x(\d+)/.exec(line);
    const intervalMatch = /Interval:\s+Discrete\s+[^()]*\(([^)]+)\)/.exec(line);

    if (formatMatch) {
      currentFormat = {
        pixelFormat: normalizeCameraInputFormat(formatMatch[1]),
        description: formatMatch[2].trim(),
        resolutions: [],
      };
      formats.push(currentFormat);
      currentResolution = null;
      continue;
    }

    if (sizeMatch && currentFormat) {
      currentResolution = {
        width: Number(sizeMatch[1]),
        height: Number(sizeMatch[2]),
        frameRates: [],
      };
      currentFormat.resolutions.push(currentResolution);
      continue;
    }

    if (intervalMatch && currentResolution) {
      currentResolution.frameRates.push(intervalMatch[1].trim());
    }
  }

  return normalizeCameraFormats(formats);
}

function parseControlFlags(rawMeta: string) {
  // v4l2-ctl reports e.g. "flags=inactive" or "flags=inactive, volatile".
  const flagsMatch = /flags=([a-z0-9_,\s-]+)/i.exec(rawMeta);
  const flags = flagsMatch
    ? flagsMatch[1].split(",").map((flag) => flag.trim().toLowerCase())
    : [];

  return {
    readOnly: flags.includes("read-only"),
    inactive: flags.includes("inactive"),
  };
}

function parseControlMeta(rawMeta: string) {
  const numberFor = (key: string) => {
    const match = new RegExp(`${key}=(-?\\d+)`).exec(rawMeta);
    return match ? Number(match[1]) : undefined;
  };

  return {
    minimum: numberFor("min"),
    maximum: numberFor("max"),
    step: numberFor("step"),
    defaultValue: numberFor("default"),
    value: numberFor("value"),
  };
}

function humanizeControlName(id: string) {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function setCameraControl(device: string, control: string, value: string | number | boolean) {
  const normalizedValue = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  await execFileText("v4l2-ctl", ["-d", device, "--set-ctrl", `${control}=${normalizedValue}`]);
}

export type ApplyCameraControlsFailure = {
  control: string;
  error: string;
};

/**
 * Generic (non-vendor-specific) V4L2 naming convention: controls that toggle
 * an automatic mode are conventionally suffixed "_automatic", "_automatic_*",
 * or "_auto" (e.g. white_balance_automatic, focus_automatic_continuous,
 * exposure_auto). Their dependent manual controls (e.g.
 * white_balance_temperature, focus_absolute, exposure_time_absolute) are
 * reported as "inactive" - and rejected by the driver with a permission
 * error - until the automatic control is turned off. Applying likely mode
 * controls first, before other controls in the same batch, makes a saved
 * profile's manual values land correctly regardless of the order they
 * happen to appear in as JSON.
 */
function looksLikeAutoModeControl(id: string) {
  return /(_automatic(_\w+)?|_auto)$/.test(id);
}

/**
 * Applies every control in a profile to the camera. Never aborts partway
 * through: a control that the driver currently refuses (commonly because a
 * related automatic mode hasn't been turned off yet, or isn't supported at
 * all) is recorded as a failure and skipped, so the rest of the profile -
 * and the capture that follows - still proceeds.
 */
export async function applyCameraControls(
  device: string,
  controls: Record<string, unknown>,
): Promise<ApplyCameraControlsFailure[]> {
  const entries = Object.entries(controls).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean",
  );

  const ordered = [...entries].sort(
    ([a], [b]) => Number(!looksLikeAutoModeControl(a)) - Number(!looksLikeAutoModeControl(b)),
  );

  const failures: ApplyCameraControlsFailure[] = [];

  for (const [control, value] of ordered) {
    try {
      await setCameraControl(device, control, value);
    } catch (error) {
      failures.push({ control, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return failures;
}
