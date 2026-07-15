import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { validateCaptureConfig } from "@/lib/captureEligibility";
import { DEFAULT_PROJECT_MILESTONES } from "@/lib/experiment";
import { validateCaptureWindowConfig } from "@/lib/schedule";
import { projectCaptureSummary, setProjectCaptureSource, validateProjectCaptureSourceSelection } from "@/lib/operations/projectCapture";
import { requireValidTimeZone, systemTimeZone } from "@/lib/timezone";
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
import { defaultProjectPhotoDirectory, isDirectoryUsable } from "@/lib/projectPaths.server";
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

    // Validate without creating - the directory itself is created lazily
    // by the first real capture/upload (see ensureDirectoryExists in
    // projectPaths.server.ts). Creating it here unconditionally, for every
    // project ever created (including throwaway/test ones that get
    // deleted immediately after), is what caused data/projects/ to
    // accumulate empty orphan directories.
    if (!(await isDirectoryUsable(localPhotoDirectory))) {
      return badRequest(`Local photo directory is not usable: ${localPhotoDirectory}`);
    }

    const captureStartAt = optionalDate(body?.captureStartAt);
    const photoIntervalMinutes = requiredPositiveInt(
      body?.photoIntervalMinutes,
      "photoIntervalMinutes",
    );
    const cameraDevice = optionalString(body?.cameraDevice);
    const captureSourceId = optionalString(body?.captureSourceId);
    const captureEnabled = body?.captureEnabled === true;
    const isTestProject = body?.isTestProject === true;
    const timeZone = body?.timeZone === undefined ? systemTimeZone() : requireValidTimeZone(body.timeZone);
    const captureWindowEnabled = body?.captureWindowEnabled === true;
    const captureWindowStartMinutes =
      body?.captureWindowStartMinutes === undefined || body?.captureWindowStartMinutes === null
        ? null
        : Number(body.captureWindowStartMinutes);
    const captureWindowEndMinutes =
      body?.captureWindowEndMinutes === undefined || body?.captureWindowEndMinutes === null
        ? null
        : Number(body.captureWindowEndMinutes);
    const windowErrors = validateCaptureWindowConfig({
      timeZone,
      captureWindowEnabled,
      captureWindowStartMinutes,
      captureWindowEndMinutes,
    });
    if (windowErrors.length > 0) {
      return badRequest(windowErrors.join(" "));
    }

    if (isTestProject && captureEnabled) {
      return badRequest("Test projects cannot enable scheduled capture.");
    }

    if (captureSourceId) {
      await validateProjectCaptureSourceSelection(prisma, captureSourceId);
    }

    if (captureEnabled && !captureSourceId) {
      const errors = validateCaptureConfig({
        captureStartAt,
        photoIntervalMinutes,
        cameraDevice,
        localPhotoDirectory,
        timeZone,
        captureWindowEnabled,
        captureWindowStartMinutes,
        captureWindowEndMinutes,
        isTestProject,
      });

      if (errors.length > 0) {
        return badRequest(errors.join(" "));
      }
    }

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          id: projectId,
          name: requiredString(body?.name, "name"),
          description: optionalString(body?.description),
          gridWidth: requiredPositiveInt(body?.gridWidth, "gridWidth"),
          gridHeight: requiredPositiveInt(body?.gridHeight, "gridHeight"),
          photoIntervalMinutes,
          captureStartAt,
          captureEnabled: isTestProject ? false : captureEnabled,
          timeZone,
          captureWindowEnabled,
          captureWindowStartMinutes,
          captureWindowEndMinutes,
          isTestProject,
          plantedAt:
            body?.plantedAt === undefined ? null : nullableDate(body.plantedAt, "plantedAt"),
          localPhotoDirectory,
          cameraDevice: isTestProject || captureSourceId ? null : cameraDevice,
          cameraName: isTestProject || captureSourceId ? null : optionalString(body?.cameraName),
          cameraProfileId: isTestProject || captureSourceId ? null : optionalString(body?.cameraProfileId),
          milestones: {
            create: DEFAULT_PROJECT_MILESTONES.map((milestone) => ({
              ...milestone,
              enabled: true,
            })),
          },
        },
      });
      if (captureSourceId) {
        await setProjectCaptureSource(tx, { projectId: created.id, captureSourceId, effectiveFrom: captureStartAt });
      }
      return created;
    });

    return NextResponse.json({ ...project, capture: await projectCaptureSummary(prisma, project.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
