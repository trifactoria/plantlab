import { NextResponse } from "next/server";
import { checkCaptureEligibility } from "@/lib/captureEligibility";
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
import { isDirectoryUsable } from "@/lib/projectPaths.server";
import { prisma } from "@/lib/prisma";
import { validateCaptureWindowConfig } from "@/lib/schedule";
import { requireValidTimeZone } from "@/lib/timezone";

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
      // Validate without creating - see ensureDirectoryExists() in
      // projectPaths.server.ts. The new directory is created lazily by
      // the next real capture/upload.
      if (!(await isDirectoryUsable(nextPhotoDirectory))) {
        return badRequest(`Photo directory is not usable: ${nextPhotoDirectory}`);
      }
    }

    const nextPhotoIntervalMinutes =
      body?.photoIntervalMinutes === undefined
        ? undefined
        : requiredPositiveInt(body.photoIntervalMinutes, "photoIntervalMinutes");
    const nextCaptureStartAt =
      body?.captureStartAt === undefined
        ? undefined
        : optionalDate(body.captureStartAt, existingProject.captureStartAt);
    const nextCameraDevice =
      body?.cameraDevice === undefined ? undefined : optionalString(body.cameraDevice);
    const nextCaptureEnabled =
      body?.captureEnabled === undefined ? undefined : body.captureEnabled === true;
    const nextIsTestProject =
      body?.isTestProject === undefined ? undefined : body.isTestProject === true;
    const mergedIsTestProject = nextIsTestProject ?? existingProject.isTestProject;
    const nextTimeZone =
      body?.timeZone === undefined ? undefined : requireValidTimeZone(body.timeZone);
    const nextCaptureWindowEnabled =
      body?.captureWindowEnabled === undefined ? undefined : body.captureWindowEnabled === true;
    const nextCaptureWindowStartMinutes =
      body?.captureWindowStartMinutes === undefined
        ? undefined
        : body.captureWindowStartMinutes === null
          ? null
          : Number(body.captureWindowStartMinutes);
    const nextCaptureWindowEndMinutes =
      body?.captureWindowEndMinutes === undefined
        ? undefined
        : body.captureWindowEndMinutes === null
          ? null
          : Number(body.captureWindowEndMinutes);

    const mergedCaptureEnabled = mergedIsTestProject ? false : (nextCaptureEnabled ?? existingProject.captureEnabled);
    if (mergedIsTestProject && nextCaptureEnabled === true) {
      return badRequest("Test projects cannot enable scheduled capture.");
    }

    const mergedTimeZone = nextTimeZone ?? existingProject.timeZone;
    const mergedWindowEnabled = nextCaptureWindowEnabled ?? existingProject.captureWindowEnabled;
    const mergedWindowStart =
      nextCaptureWindowStartMinutes === undefined
        ? existingProject.captureWindowStartMinutes
        : nextCaptureWindowStartMinutes;
    const mergedWindowEnd =
      nextCaptureWindowEndMinutes === undefined
        ? existingProject.captureWindowEndMinutes
        : nextCaptureWindowEndMinutes;
    const windowErrors = validateCaptureWindowConfig({
      timeZone: mergedTimeZone,
      captureWindowEnabled: mergedWindowEnabled,
      captureWindowStartMinutes: mergedWindowStart,
      captureWindowEndMinutes: mergedWindowEnd,
    });
    if (windowErrors.length > 0) {
      return badRequest(windowErrors.join(" "));
    }

    if (mergedCaptureEnabled) {
      const eligibility = await checkCaptureEligibility({
        captureEnabled: true,
        captureStartAt: nextCaptureStartAt ?? existingProject.captureStartAt,
        photoIntervalMinutes: nextPhotoIntervalMinutes ?? existingProject.photoIntervalMinutes,
        cameraDevice: nextCameraDevice ?? existingProject.cameraDevice,
        localPhotoDirectory: nextPhotoDirectory ?? existingProject.localPhotoDirectory,
        timeZone: mergedTimeZone,
        captureWindowEnabled: mergedWindowEnabled,
        captureWindowStartMinutes: mergedWindowStart,
        captureWindowEndMinutes: mergedWindowEnd,
        isTestProject: mergedIsTestProject,
      });

      if (!eligibility.eligible) {
        return badRequest(eligibility.errors.join(" "));
      }
    }

    const cameraProfileId =
      nextIsTestProject === true
        ? null
        : body?.cameraProfileId === undefined
          ? undefined
          : optionalString(body.cameraProfileId);

    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: body?.name === undefined ? undefined : requiredString(body.name, "name"),
        description:
          body?.description === undefined ? undefined : optionalString(body.description),
        gridWidth: nextGridWidth,
        gridHeight: nextGridHeight,
        photoIntervalMinutes: nextPhotoIntervalMinutes,
        captureStartAt: nextCaptureStartAt,
        captureEnabled: nextIsTestProject === true ? false : nextCaptureEnabled,
        timeZone: nextTimeZone,
        captureWindowEnabled: nextCaptureWindowEnabled,
        captureWindowStartMinutes: nextCaptureWindowStartMinutes,
        captureWindowEndMinutes: nextCaptureWindowEndMinutes,
        isTestProject: nextIsTestProject,
        plantedAt:
          body?.plantedAt === undefined
            ? undefined
            : nullableDate(body.plantedAt, "plantedAt"),
        localPhotoDirectory: nextPhotoDirectory,
        cameraDevice: nextIsTestProject === true ? null : nextCameraDevice,
        cameraName:
          nextIsTestProject === true
            ? null
            : body?.cameraName === undefined
              ? undefined
              : optionalString(body.cameraName),
        cameraStableId:
          nextIsTestProject === true
            ? null
            : body?.cameraStableId === undefined
              ? undefined
              : optionalString(body.cameraStableId),
        cameraProfileId,
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
