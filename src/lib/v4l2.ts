import { execFile } from "node:child_process";
import { composeStableId, readUsbIdentity } from "./cameraIdentity";

export type LocalCamera = {
  name: string;
  device: string;
  supportsCapture: boolean;
  /** Stable USB-based identity, when Linux exposes enough information to compute one. */
  stableId: string | null;
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

export type CameraFormatResolution = {
  width: number;
  height: number;
  frameRates: string[];
};

export type CameraFormat = {
  pixelFormat: string;
  description: string;
  resolutions: CameraFormatResolution[];
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
  const cameras: LocalCamera[] = [];
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
    cameras.push({ name: currentName, device, supportsCapture, stableId });
  }

  return cameras.sort((a, b) => {
    if (a.supportsCapture !== b.supportsCapture) {
      return a.supportsCapture ? -1 : 1;
    }

    return a.device.localeCompare(b.device, undefined, { numeric: true });
  });
}

async function deviceSupportsCapture(device: string) {
  const output = await execFileText("v4l2-ctl", ["-d", device, "--all"]);
  return /Video Capture|Video Capture Multiplanar/.test(output);
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
  const formats: CameraFormat[] = [];
  let currentFormat: CameraFormat | null = null;
  let currentResolution: CameraFormatResolution | null = null;

  for (const line of output.split("\n")) {
    const formatMatch = /\[\d+\]:\s+'([^']+)'\s+\(([^)]+)\)/.exec(line);
    const sizeMatch = /Size:\s+Discrete\s+(\d+)x(\d+)/.exec(line);
    const intervalMatch = /Interval:\s+Discrete\s+[^()]*\(([^)]+)\)/.exec(line);

    if (formatMatch) {
      currentFormat = {
        pixelFormat: formatMatch[1].toLowerCase(),
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

  return formats;
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
