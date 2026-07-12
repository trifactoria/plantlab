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
import { isValidRotation } from "@/lib/orientation";
import { requireValidTimeZone, systemTimeZone } from "@/lib/timezone";

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

    const source = await prisma.captureSource.create({
      data: {
        id,
        name: requiredString(body?.name, "name"),
        cameraDevice: requiredString(body?.cameraDevice, "cameraDevice"),
        cameraName: optionalString(body?.cameraName),
        cameraStableId: optionalString(body?.cameraStableId),
        cameraProfileId: optionalString(body?.cameraProfileId),
        width: requiredPositiveInt(body?.width, "width"),
        height: requiredPositiveInt(body?.height, "height"),
        rotation,
        flipHorizontal: body?.flipHorizontal === true,
        flipVertical: body?.flipVertical === true,
        captureDirectory,
        active: body?.active !== false,
        photoIntervalMinutes: requiredPositiveInt(body?.photoIntervalMinutes, "photoIntervalMinutes"),
        captureStartAt: optionalDate(body?.captureStartAt),
        timeZone: body?.timeZone === undefined ? systemTimeZone() : requireValidTimeZone(body.timeZone),
        captureWindowEnabled: body?.captureWindowEnabled === true,
        captureWindowStartMinutes:
          body?.captureWindowStartMinutes === undefined || body?.captureWindowStartMinutes === null
            ? null
            : Number(body.captureWindowStartMinutes),
        captureWindowEndMinutes:
          body?.captureWindowEndMinutes === undefined || body?.captureWindowEndMinutes === null
            ? null
            : Number(body.captureWindowEndMinutes),
      },
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not create capture source");
  }
}
