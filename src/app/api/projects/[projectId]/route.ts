import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  badRequest,
  nullableDate,
  notFound,
  optionalDate,
  optionalString,
  readJson,
  requiredPositiveInt,
  requiredString,
  serverError,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      plants: true,
      photos: { orderBy: { timestamp: "desc" } },
    },
  });

  if (!project) {
    return notFound("Project not found");
  }

  return NextResponse.json(project);
}

export async function PATCH(request: Request, context: Context) {
  const { projectId } = await context.params;
  const body = await readJson(request);

  try {
    const existingProject = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!existingProject) {
      return notFound("Project not found");
    }

    const nextGridWidth =
      body?.gridWidth === undefined
        ? undefined
        : requiredPositiveInt(body.gridWidth, "gridWidth");
    const nextGridHeight =
      body?.gridHeight === undefined
        ? undefined
        : requiredPositiveInt(body.gridHeight, "gridHeight");

    if (nextGridWidth !== undefined || nextGridHeight !== undefined) {
      const width = nextGridWidth ?? existingProject.gridWidth;
      const height = nextGridHeight ?? existingProject.gridHeight;
      const outsidePlant = await prisma.plant.findFirst({
        where: {
          projectId,
          OR: [{ gridX: { gte: width } }, { gridY: { gte: height } }],
        },
      });

      if (outsidePlant) {
        return badRequest(
          "Cannot shrink grid because at least one plant would fall outside the new dimensions.",
        );
      }
    }

    const nextPhotoDirectory =
      body?.localPhotoDirectory === undefined
        ? undefined
        : requiredString(body.localPhotoDirectory, "localPhotoDirectory");

    if (
      nextPhotoDirectory !== undefined &&
      nextPhotoDirectory !== existingProject.localPhotoDirectory
    ) {
      try {
        await mkdir(nextPhotoDirectory, { recursive: true });
      } catch (error) {
        console.error(error);
        return badRequest(`Could not create photo directory: ${nextPhotoDirectory}`);
      }
    }

    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: body?.name === undefined ? undefined : requiredString(body.name, "name"),
        description:
          body?.description === undefined ? undefined : optionalString(body.description),
        gridWidth: nextGridWidth,
        gridHeight: nextGridHeight,
        photoIntervalMinutes:
          body?.photoIntervalMinutes === undefined
            ? undefined
            : requiredPositiveInt(
                body.photoIntervalMinutes,
                "photoIntervalMinutes",
              ),
        captureStartAt:
          body?.captureStartAt === undefined
            ? undefined
            : optionalDate(body.captureStartAt, existingProject.captureStartAt),
        plantedAt:
          body?.plantedAt === undefined
            ? undefined
            : nullableDate(body.plantedAt, "plantedAt"),
        localPhotoDirectory: nextPhotoDirectory,
        cameraDevice:
          body?.cameraDevice === undefined ? undefined : optionalString(body.cameraDevice),
        cameraName:
          body?.cameraName === undefined ? undefined : optionalString(body.cameraName),
        cameraProfileId:
          body?.cameraProfileId === undefined
            ? undefined
            : optionalString(body.cameraProfileId),
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return notFound("Project not found");
  }

  await prisma.project.delete({ where: { id: projectId } });

  return NextResponse.json({
    deleted: true,
    projectId,
    preservedPhotoDirectory: project.localPhotoDirectory,
  });
}
