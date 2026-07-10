import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import { validateCaptureConfig } from "@/lib/captureEligibility";
import {
  badRequest,
  nullableDate,
  optionalDate,
  optionalString,
  readJson,
  requiredPositiveInt,
  requiredString,
  serverError,
} from "@/lib/http";
import { defaultProjectPhotoDirectory } from "@/lib/projectPaths";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(projects);
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const projectId = randomUUID();
    const useDefaultPhotoDirectory = body?.useDefaultPhotoDirectory !== false;
    const localPhotoDirectory = useDefaultPhotoDirectory
      ? defaultProjectPhotoDirectory(projectId)
      : requiredString(body?.localPhotoDirectory, "localPhotoDirectory");
    const captureStartAt = optionalDate(body?.captureStartAt);
    const photoIntervalMinutes = requiredPositiveInt(
      body?.photoIntervalMinutes,
      "photoIntervalMinutes",
    );
    const cameraDevice = optionalString(body?.cameraDevice);
    const captureEnabled = body?.captureEnabled === true;

    if (captureEnabled) {
      const errors = validateCaptureConfig({
        captureStartAt,
        photoIntervalMinutes,
        cameraDevice,
        localPhotoDirectory,
      });

      if (errors.length > 0) {
        return badRequest(errors.join(" "));
      }
    }

    const project = await prisma.project.create({
      data: {
        id: projectId,
        name: requiredString(body?.name, "name"),
        description: optionalString(body?.description),
        gridWidth: requiredPositiveInt(body?.gridWidth, "gridWidth"),
        gridHeight: requiredPositiveInt(body?.gridHeight, "gridHeight"),
        photoIntervalMinutes,
        captureStartAt,
        captureEnabled,
        plantedAt:
          body?.plantedAt === undefined ? null : nullableDate(body.plantedAt, "plantedAt"),
        localPhotoDirectory,
        cameraDevice,
        cameraName: optionalString(body?.cameraName),
        cameraProfileId: optionalString(body?.cameraProfileId),
      },
    });

    try {
      await mkdir(localPhotoDirectory, { recursive: true });
    } catch (error) {
      console.error(error);
      await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
      return badRequest(`Could not create photo directory: ${localPhotoDirectory}`);
    }

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
