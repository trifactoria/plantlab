import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  badRequest,
  optionalDate,
  optionalString,
  readJson,
  requiredPositiveInt,
  requiredString,
} from "@/lib/http";
import { defaultCaptureSourceDirectory, isDirectoryUsable } from "@/lib/projectPaths.server";
import { prisma } from "@/lib/prisma";
import { normalizeCameraInputFormat } from "@/lib/cameraModes";
import { isValidRotation } from "@/lib/orientation";
import { defaultCaptureSourceScheduleForNode } from "@/lib/captureSourceDefaults";
import { validateCaptureWindowConfig } from "@/lib/schedule";
import { requireValidTimeZone } from "@/lib/timezone";

export const runtime = "nodejs";

export async function GET() {
  const sources = await prisma.captureSource.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { viewports: true, sourceCaptures: true } },
    },
  });

  return NextResponse.json({ sources });
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const id = randomUUID();
    const rotation = body?.rotation === undefined ? 0 : Number(body.rotation);
    if (!isValidRotation(rotation)) {
      return badRequest("rotation must be one of 0, 90, 180, 270");
    }

    const captureDirectory =
      body?.captureDirectory === undefined
        ? defaultCaptureSourceDirectory(id)
        : requiredString(body.captureDirectory, "captureDirectory");

    // Validate without creating - see ensureDirectoryExists() in
    // projectPaths.server.ts. The directory is created lazily by the
    // first real source capture.
    if (!(await isDirectoryUsable(captureDirectory))) {
      return badRequest(`Capture directory is not usable: ${captureDirectory}`);
    }

    const name = requiredString(body?.name, "name");
    const cameraDevice = requiredString(body?.cameraDevice, "cameraDevice");
    const cameraName = optionalString(body?.cameraName);
    const cameraStableId = optionalString(body?.cameraStableId);
    const width = requiredPositiveInt(body?.width, "width");
    const height = requiredPositiveInt(body?.height, "height");
    const explicitProfileId = optionalString(body?.cameraProfileId);
    const inputFormat = body?.inputFormat === undefined ? null : normalizeCameraInputFormat(String(body.inputFormat));
    const scheduleDefaults = defaultCaptureSourceScheduleForNode(null);
    const timeZone = body?.timeZone === undefined ? scheduleDefaults.timeZone : requireValidTimeZone(body.timeZone);
    const captureWindowEnabled =
      body?.dailyWindowEnabled !== undefined
        ? body.dailyWindowEnabled === true
        : body?.captureWindowEnabled === undefined
          ? scheduleDefaults.captureWindowEnabled
          : body.captureWindowEnabled === true;
    const captureWindowStartMinutes =
      body?.dailyWindowStartMinutes !== undefined
        ? body.dailyWindowStartMinutes === null
          ? null
          : Number(body.dailyWindowStartMinutes)
        : body?.captureWindowStartMinutes === undefined
        ? scheduleDefaults.captureWindowStartMinutes
        : body.captureWindowStartMinutes === null
          ? null
          : Number(body.captureWindowStartMinutes);
    const captureWindowEndMinutes =
      body?.dailyWindowEndMinutes !== undefined
        ? body.dailyWindowEndMinutes === null
          ? null
          : Number(body.dailyWindowEndMinutes)
        : body?.captureWindowEndMinutes === undefined
        ? scheduleDefaults.captureWindowEndMinutes
        : body.captureWindowEndMinutes === null
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

    const source = await prisma.$transaction(async (tx) => {
      const profile =
        explicitProfileId || !inputFormat
          ? null
          : await tx.cameraProfile.create({
              data: {
                name: `${name} mode`,
                cameraDevice,
                cameraName,
                cameraStableId,
                width,
                height,
                inputFormat,
              },
            });

      return tx.captureSource.create({
        data: {
          id,
          name,
          cameraDevice,
          cameraName,
          cameraStableId,
          cameraProfileId: explicitProfileId ?? profile?.id ?? null,
          width,
          height,
          rotation,
          flipHorizontal: body?.flipHorizontal === true,
          flipVertical: body?.flipVertical === true,
          captureDirectory,
          active: body?.active !== false,
          photoIntervalMinutes:
            body?.intervalMinutes !== undefined
              ? requiredPositiveInt(body.intervalMinutes, "intervalMinutes")
              : body?.photoIntervalMinutes === undefined
              ? scheduleDefaults.photoIntervalMinutes
              : requiredPositiveInt(body.photoIntervalMinutes, "photoIntervalMinutes"),
          captureStartAt: optionalDate(body?.captureStartAt),
          timeZone,
          captureWindowEnabled,
          captureWindowStartMinutes,
          captureWindowEndMinutes,
        },
      });
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not create capture source");
  }
}
