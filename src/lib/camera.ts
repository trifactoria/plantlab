import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CameraProfile, Photo, Project } from "@prisma/client";
import { withCameraLock } from "./cameraLock";
import { formatLocalTimestamp } from "./photos";
import { prisma } from "./prisma";
import { applyCameraControls } from "./v4l2";

type CameraSettings = {
  device: string;
  width: number;
  height: number;
  inputFormat: string;
  controls?: Record<string, unknown>;
};

type CaptureResult = {
  photo: Photo;
  savedPath: string;
};

type CaptureOptions = {
  notes?: string | null;
};

function parsePositiveInt(value: string | undefined, fallback: number, name: string) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function getCameraSettings(
  project?: Pick<Project, "cameraDevice"> & { cameraProfile?: CameraProfile | null },
): CameraSettings {
  const device = process.env.CAMERA_DEVICE || project?.cameraDevice;

  if (!device) {
    throw new Error("No camera selected for this project.");
  }

  const profile = project?.cameraProfile;
  return {
    device,
    width: parsePositiveInt(process.env.CAMERA_WIDTH, profile?.width ?? 1920, "CAMERA_WIDTH"),
    height: parsePositiveInt(process.env.CAMERA_HEIGHT, profile?.height ?? 1080, "CAMERA_HEIGHT"),
    inputFormat: process.env.CAMERA_INPUT_FORMAT || profile?.inputFormat || "mjpeg",
    controls: profile?.controlsJson ? JSON.parse(profile.controlsJson) : undefined,
  };
}

function ffmpegFailureMessage(settings: CameraSettings, stderr: string) {
  const details = stderr.trim() ? `\n\nffmpeg output:\n${stderr.trim()}` : "";

  return [
    `ffmpeg could not capture from ${settings.device} at ${settings.width}x${settings.height}.`,
    `Confirm the device and supported formats with: v4l2-ctl -d ${settings.device} --list-formats-ext`,
    details,
  ].join("\n");
}

function warmupSeconds() {
  return parsePositiveInt(process.env.CAMERA_WARMUP_SECONDS, 2, "CAMERA_WARMUP_SECONDS");
}

function ffmpegInputFormat(format: string) {
  return format.toLowerCase() === "mjpg" ? "mjpeg" : format;
}

async function applyProfileSettings(settings: CameraSettings) {
  if (settings.controls) {
    await applyCameraControls(settings.device, settings.controls);
  }
}

export type FfmpegCaptureOptions = {
  /**
   * Intended warm-up behavior, made explicit:
   *
   * 1. ffmpeg opens the camera and requests one frame per second
   *    (`-vf fps=1`) for `warmupSeconds + 1` total seconds.
   * 2. `-update 1` tells ffmpeg's image2 muxer to keep overwriting the same
   *    outputPath every second rather than writing frame0001.jpg,
   *    frame0002.jpg, etc. Auto-exposure/auto-focus/auto-white-balance are
   *    given that time to settle; every overwritten frame before the last
   *    one is discarded - only the final, settled frame ends up on disk.
   * 3. No temporary video file is ever produced - the muxer output is a
   *    single still image the whole time, just repeatedly replaced.
   * 4. The caller timestamps Photo.timestamp immediately after this
   *    resolves, so it reflects when the final settled frame was written,
   *    not when the request started.
   * 5. The caller also writes to a `.tmp.jpg`-prefixed path and only
   *    renames it to its real, final path after ffmpeg exits successfully,
   *    so a still-settling capture can never be mistaken for a finished
   *    Photo (a partially-written or mid-warmup file never appears at the
   *    final path).
   */
  warmup?: boolean;
  /** Override for testing; defaults to warmupSeconds() (env-configurable). */
  warmupSeconds?: number;
};

/** Pure argument builder, kept separate from spawn() so it can be unit tested. */
export function buildFfmpegArgs(
  settings: CameraSettings,
  outputPath: string,
  options: FfmpegCaptureOptions = {},
): string[] {
  const durationSeconds = options.warmup ? (options.warmupSeconds ?? warmupSeconds()) + 1 : 1;

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "v4l2",
    "-input_format",
    ffmpegInputFormat(settings.inputFormat),
    "-video_size",
    `${settings.width}x${settings.height}`,
    "-i",
    settings.device,
    "-t",
    String(durationSeconds),
    "-vf",
    "fps=1",
    "-update",
    "1",
    "-q:v",
    "2",
    "-y",
    outputPath,
  ];
}

function runFfmpeg(settings: CameraSettings, outputPath: string, options: FfmpegCaptureOptions = {}) {
  const args = buildFfmpegArgs(settings, outputPath, options);

  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { shell: false });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Could not start ffmpeg: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(ffmpegFailureMessage(settings, stderr)));
    });
  });
}

export async function nextCapturePath(directory: string, capturedAt: Date) {
  const timestamp = formatLocalTimestamp(capturedAt);
  let candidate = path.join(directory, `${timestamp}.jpg`);
  let suffix = 1;

  while (existsSync(candidate)) {
    candidate = path.join(directory, `${timestamp}-${suffix}.jpg`);
    suffix += 1;
  }

  return candidate;
}

export async function captureProjectPhoto(projectId: string, options: CaptureOptions = {}): Promise<CaptureResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { cameraProfile: true },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const settings = getCameraSettings(project);
  await mkdir(project.localPhotoDirectory, { recursive: true });

  const temporaryPath = path.join(
    project.localPhotoDirectory,
    `.plantlab-capture-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.jpg`,
  );
  let savedPath = "";
  let capturedAt = new Date();

  await withCameraLock(settings.device, async () => {
    await applyProfileSettings(settings);

    try {
      await runFfmpeg(settings, temporaryPath, { warmup: true });
      // The final settled frame was just written - timestamp the photo now,
      // not at request time, so it reflects the actual captured moment.
      capturedAt = new Date();
      savedPath = await nextCapturePath(project.localPhotoDirectory, capturedAt);
      await rename(temporaryPath, savedPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  });

  const photo = await prisma.photo.create({
    data: {
      projectId: project.id,
      filename: path.basename(savedPath),
      path: savedPath,
      timestamp: capturedAt,
      notes: options.notes ?? null,
    },
  });

  return { photo, savedPath };
}

/**
 * Captures a single temporary, non-gallery frame at the given settings and
 * returns its bytes. Shared by the live preview, Auto Calibrate's
 * before/after snapshots, and the resolution comparison tool - none of
 * those register a Photo. Each call acquires and releases the camera lock
 * individually, so a long-running preview/comparison session never holds
 * the camera continuously.
 */
export async function capturePreviewFrame(settings: CameraSettings): Promise<Buffer> {
  const temporaryPath = path.join(
    os.tmpdir(),
    `plantlab-preview-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`,
  );

  return withCameraLock(settings.device, async () => {
    try {
      await runFfmpeg(settings, temporaryPath);
      return await readFile(temporaryPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  });
}

export async function capturePreviewImage(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { cameraProfile: true },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  return capturePreviewFrame(getCameraSettings(project));
}
