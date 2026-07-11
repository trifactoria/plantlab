import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";

export async function createTestCaptureSource(
  prisma: PrismaClient,
  overrides: Partial<{
    name: string;
    cameraDevice: string;
    width: number;
    height: number;
    rotation: number;
    flipHorizontal: boolean;
    flipVertical: boolean;
    active: boolean;
    photoIntervalMinutes: number;
    captureStartAt: Date;
    timeZone: string;
  }> = {},
) {
  const id = `vitest-source-${randomUUID()}`;
  const captureDirectory = await mkdtemp(path.join(os.tmpdir(), "plantlab-vitest-source-"));

  const source = await prisma.captureSource.create({
    data: {
      id,
      name: overrides.name ?? `Vitest Shelf ${id}`,
      cameraDevice: overrides.cameraDevice ?? `/dev/video-vitest-source-${id}`,
      width: overrides.width ?? 400,
      height: overrides.height ?? 300,
      rotation: overrides.rotation ?? 0,
      flipHorizontal: overrides.flipHorizontal ?? false,
      flipVertical: overrides.flipVertical ?? false,
      captureDirectory,
      active: overrides.active ?? true,
      photoIntervalMinutes: overrides.photoIntervalMinutes ?? 30,
      captureStartAt: overrides.captureStartAt ?? new Date(),
      timeZone: overrides.timeZone ?? "America/New_York",
    },
  });

  return source;
}

/**
 * Writes a real quadrant-colored JPEG (top-left red, top-right green,
 * bottom-left blue, bottom-right yellow) and a matching SourceCapture row,
 * so orientation/fan-out tests can verify real pixels rather than trusting
 * dimensions alone.
 */
export async function createRealSourceCapture(
  prisma: PrismaClient,
  captureSourceId: string,
  overrides: Partial<{ timestamp: Date; scheduledFor: Date | null; rawWidth: number; rawHeight: number }> = {},
) {
  const id = `vitest-source-capture-${randomUUID()}`;
  const source = await prisma.captureSource.findUniqueOrThrow({ where: { id: captureSourceId } });
  const directory = await mkdtemp(path.join(os.tmpdir(), "plantlab-vitest-sourcecap-"));
  const filePath = path.join(directory, `${id}.jpg`);

  const rawWidth = overrides.rawWidth ?? source.width;
  const rawHeight = overrides.rawHeight ?? source.height;
  const halfW = Math.floor(rawWidth / 2);
  const halfH = Math.floor(rawHeight / 2);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${rawWidth}" height="${rawHeight}">
      <rect x="0" y="0" width="${halfW}" height="${halfH}" fill="#ff0000"/>
      <rect x="${halfW}" y="0" width="${rawWidth - halfW}" height="${halfH}" fill="#00ff00"/>
      <rect x="0" y="${halfH}" width="${halfW}" height="${rawHeight - halfH}" fill="#0000ff"/>
      <rect x="${halfW}" y="${halfH}" width="${rawWidth - halfW}" height="${rawHeight - halfH}" fill="#ffff00"/>
    </svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  await writeFile(filePath, buffer);

  const sourceCapture = await prisma.sourceCapture.create({
    data: {
      id,
      captureSourceId,
      timestamp: overrides.timestamp ?? new Date(),
      scheduledFor: overrides.scheduledFor ?? null,
      originalPath: filePath,
      originalWidth: rawWidth,
      originalHeight: rawHeight,
      workingWidth: source.width,
      workingHeight: source.height,
      pixelFormat: "mjpeg",
    },
  });

  return { sourceCapture, directory, filePath };
}

export async function cleanupTestCaptureSource(prisma: PrismaClient, captureSourceId: string, directory?: string) {
  await prisma.captureSource.deleteMany({ where: { id: captureSourceId } });

  if (directory) {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
