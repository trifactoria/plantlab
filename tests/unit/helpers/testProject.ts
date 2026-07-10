import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

export async function createTestProject(
  prisma: PrismaClient,
  overrides: Partial<{
    name: string;
    captureEnabled: boolean;
    captureStartAt: Date;
    photoIntervalMinutes: number;
    cameraDevice: string | null;
    localPhotoDirectory: string;
  }> = {},
) {
  const id = `vitest-${randomUUID()}`;
  const localPhotoDirectory =
    overrides.localPhotoDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "plantlab-vitest-")));

  const project = await prisma.project.create({
    data: {
      id,
      name: overrides.name ?? `Vitest Project ${id}`,
      gridWidth: 1,
      gridHeight: 1,
      photoIntervalMinutes: overrides.photoIntervalMinutes ?? 30,
      captureStartAt: overrides.captureStartAt ?? new Date(),
      captureEnabled: overrides.captureEnabled ?? true,
      localPhotoDirectory,
      cameraDevice: overrides.cameraDevice === undefined ? `/dev/video-vitest-${id}` : overrides.cameraDevice,
    },
  });

  return project;
}

export async function createFakePhoto(prisma: PrismaClient, projectId: string) {
  const id = `vitest-photo-${randomUUID()}`;
  const photo = await prisma.photo.create({
    data: {
      id,
      projectId,
      filename: `${id}.jpg`,
      path: `/tmp/${id}.jpg`,
      timestamp: new Date(),
    },
  });

  return photo;
}

export async function cleanupTestProject(prisma: PrismaClient, projectId: string, directory?: string) {
  await prisma.captureRun.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });

  if (directory) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
