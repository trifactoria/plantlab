import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";

export async function createTestPlant(
  prisma: PrismaClient,
  projectId: string,
  overrides: Partial<{ gridX: number; gridY: number; name: string }> = {},
) {
  const id = `vitest-plant-${randomUUID()}`;
  return prisma.plant.create({
    data: {
      id,
      projectId,
      name: overrides.name ?? `Vitest Plant ${id}`,
      gridX: overrides.gridX ?? 0,
      gridY: overrides.gridY ?? 0,
    },
  });
}

/** Writes a small, real JPEG to disk so sharp-based thumbnail tests have real pixels to read. */
export async function createRealPhoto(
  prisma: PrismaClient,
  projectId: string,
  overrides: Partial<{ timestamp: Date; width: number; height: number }> = {},
) {
  const id = `vitest-photo-${randomUUID()}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "plantlab-vitest-photo-"));
  const filePath = path.join(directory, `${id}.jpg`);
  const width = overrides.width ?? 200;
  const height = overrides.height ?? 150;

  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await writeFile(filePath, buffer);

  const photo = await prisma.photo.create({
    data: {
      id,
      projectId,
      filename: `${id}.jpg`,
      path: filePath,
      timestamp: overrides.timestamp ?? new Date(),
    },
  });

  return { photo, directory, width, height };
}
