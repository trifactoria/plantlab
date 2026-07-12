import { readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { CameraProfile, CaptureSource, SourceCapture } from "@prisma/client";
import { applyProfileSettings, nextCapturePath, runFfmpeg, type CameraSettings } from "./camera";
import { withCameraLock } from "./cameraLock";
import { verifyCapturedDimensions } from "./captureVerify";
import { parseRotation, transformedDimensions, type Rotation } from "./orientation";
import { ensureDirectoryExists } from "./projectPaths.server";
import { prisma } from "./prisma";
import { isUniqueConstraintError } from "./prismaErrors";

export type CaptureSourceSettings = CameraSettings & {
  rotation: Rotation;
  flipHorizontal: boolean;
  flipVertical: boolean;
  workingWidth: number;
  workingHeight: number;
};

/**
 * Resolves the physical capture settings for a shared CaptureSource. Mirrors
 * getCameraSettings() in camera.ts, but keyed off CaptureSource instead of
 * Project. CaptureSource.width/height store the TRANSFORMED (post-rotation)
 * working dimensions, so the raw dimensions requested from the device are
 * derived by applying the (self-inverse) rotation transform once more.
 */
export function getCaptureSourceSettings(
  source: CaptureSource & { cameraProfile?: CameraProfile | null },
): CaptureSourceSettings {
  const rotation = parseRotation(source.rotation);
  const raw = transformedDimensions(source.width, source.height, rotation);

  return {
    device: source.cameraDevice,
    width: raw.width,
    height: raw.height,
    inputFormat: source.cameraProfile?.inputFormat || "mjpeg",
    controls: source.cameraProfile?.controlsJson ? JSON.parse(source.cameraProfile.controlsJson) : undefined,
    rotation,
    flipHorizontal: source.flipHorizontal,
    flipVertical: source.flipVertical,
    workingWidth: source.width,
    workingHeight: source.height,
  };
}

export type CaptureSourceOptions = {
  /** Set for scheduled captures so retries/overlapping ticks can be deduplicated; omit for manual/test captures. */
  scheduledFor?: Date;
};

export type CaptureSourceResult = {
  sourceCapture: SourceCapture;
  savedPath: string;
  /** True if a SourceCapture for this source+scheduledFor already existed (idempotent retry) - the freshly captured file was discarded. */
  alreadyExisted: boolean;
};

/**
 * Captures one full-resolution frame from a shared CaptureSource. Mirrors
 * captureProjectPhoto()'s safety pattern exactly: camera lock -> temp file
 * -> verify actual dimensions -> atomic rename -> DB row, unlinking the file
 * on any failure so nothing is ever left orphaned on disk or referenced by a
 * DB row that failed to write.
 *
 * For scheduled captures (options.scheduledFor set), a unique index on
 * (captureSourceId, scheduledFor) makes this idempotent: a retried or
 * overlapping tick for the same slot discards its redundant capture and
 * returns the existing row instead of creating a duplicate.
 */
export async function captureSourcePhoto(
  captureSourceId: string,
  options: CaptureSourceOptions = {},
): Promise<CaptureSourceResult> {
  const source = await prisma.captureSource.findUnique({
    where: { id: captureSourceId },
    include: { cameraProfile: true },
  });

  if (!source) {
    throw new Error(`Capture source not found: ${captureSourceId}`);
  }

  if (!source.active) {
    throw new Error(`Capture source is not active: ${captureSourceId}`);
  }

  const settings = getCaptureSourceSettings(source);
  await ensureDirectoryExists(source.captureDirectory);

  const temporaryPath = path.join(
    source.captureDirectory,
    `.plantlab-source-capture-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.jpg`,
  );
  let savedPath = "";
  let capturedAt = new Date();
  let buffer: Buffer = Buffer.alloc(0);

  await withCameraLock(settings.device, async () => {
    await applyProfileSettings(settings);

    try {
      await runFfmpeg(settings, temporaryPath, { warmup: true });
      capturedAt = new Date();
      buffer = await readFile(temporaryPath);
      savedPath = await nextCapturePath(source.captureDirectory, capturedAt);
      await rename(temporaryPath, savedPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  });

  const verification = await verifyCapturedDimensions(buffer, { width: settings.width, height: settings.height });

  try {
    const sourceCapture = await prisma.sourceCapture.create({
      data: {
        captureSourceId: source.id,
        timestamp: capturedAt,
        scheduledFor: options.scheduledFor ?? null,
        originalPath: savedPath,
        originalWidth: verification.actualWidth,
        originalHeight: verification.actualHeight,
        workingWidth: settings.workingWidth,
        workingHeight: settings.workingHeight,
        pixelFormat: settings.inputFormat,
      },
    });

    return { sourceCapture, savedPath, alreadyExisted: false };
  } catch (error) {
    // The frame is already on disk - don't leave it orphaned if the DB
    // write fails (including the expected duplicate-slot conflict below).
    await unlink(savedPath).catch(() => undefined);

    if (isUniqueConstraintError(error) && options.scheduledFor) {
      const existing = await prisma.sourceCapture.findUnique({
        where: {
          captureSourceId_scheduledFor: {
            captureSourceId: source.id,
            scheduledFor: options.scheduledFor,
          },
        },
      });
      if (existing) {
        return { sourceCapture: existing, savedPath: existing.originalPath, alreadyExisted: true };
      }
    }

    throw error;
  }
}
