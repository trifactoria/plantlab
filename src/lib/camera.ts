import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Photo, Project } from "@prisma/client";
import { formatLocalTimestamp } from "./photos";
import { prisma } from "./prisma";

type CameraSettings = {
  device: string;
  width: number;
  height: number;
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

export function getCameraSettings(project?: Pick<Project, "cameraDevice">): CameraSettings {
  const device = process.env.CAMERA_DEVICE || project?.cameraDevice;

  if (!device) {
    throw new Error("No camera selected for this project.");
  }

  return {
    device,
    width: parsePositiveInt(process.env.CAMERA_WIDTH, 1920, "CAMERA_WIDTH"),
    height: parsePositiveInt(process.env.CAMERA_HEIGHT, 1080, "CAMERA_HEIGHT"),
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

function runFfmpeg(settings: CameraSettings, outputPath: string) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "v4l2",
    "-input_format",
    "mjpeg",
    "-video_size",
    `${settings.width}x${settings.height}`,
    "-i",
    settings.device,
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

async function nextCapturePath(directory: string, capturedAt: Date) {
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
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const settings = getCameraSettings(project);
  await mkdir(project.localPhotoDirectory, { recursive: true });

  const capturedAt = new Date();
  const savedPath = await nextCapturePath(project.localPhotoDirectory, capturedAt);
  const temporaryPath = savedPath.replace(/\.jpg$/, ".tmp.jpg");

  try {
    await runFfmpeg(settings, temporaryPath);
    await rename(temporaryPath, savedPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

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

const activePreviewDevices = new Set<string>();

export async function capturePreviewImage(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const settings = getCameraSettings(project);

  if (activePreviewDevices.has(settings.device)) {
    throw new Error("A preview capture is already in progress for this camera.");
  }

  activePreviewDevices.add(settings.device);
  const temporaryPath = path.join(
    os.tmpdir(),
    `plantlab-preview-${projectId}-${Date.now()}.jpg`,
  );

  try {
    await runFfmpeg(settings, temporaryPath);
    return await readFile(temporaryPath);
  } finally {
    activePreviewDevices.delete(settings.device);
    await unlink(temporaryPath).catch(() => undefined);
  }
}
