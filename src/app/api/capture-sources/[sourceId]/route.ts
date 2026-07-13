import { NextResponse } from "next/server";
import { badRequest, notFound, optionalString, readJson, requiredPositiveInt } from "@/lib/http";
import { isValidRotation } from "@/lib/orientation";
import { prisma } from "@/lib/prisma";
import { requireValidTimeZone } from "@/lib/timezone";
import { normalizeCameraInputFormat } from "@/lib/cameraModes";
import { cameraSupportsMode, parseNodeCameraFormats } from "@/lib/operations/nodeCameras";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ sourceId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: {
      cameraProfile: true,
      sourceCaptures: { orderBy: { timestamp: "desc" }, take: 1 },
      viewports: {
        where: { active: true },
        orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
        distinct: ["projectId"],
        include: { project: { select: { id: true, name: true } } },
      },
    },
  });

  if (!source) {
    return notFound("Capture source not found");
  }

  return NextResponse.json(source);
}

export async function PATCH(request: Request, context: Context) {
  const { sourceId } = await context.params;
  const existing = await prisma.captureSource.findUnique({ where: { id: sourceId } });
  if (!existing) {
    return notFound("Capture source not found");
  }

  const body = await readJson(request);

  try {
    const data: Record<string, unknown> = {};

    if (body?.name !== undefined) data.name = String(body.name).trim();
    if (body?.cameraDevice !== undefined) data.cameraDevice = String(body.cameraDevice).trim();
    if (body?.cameraName !== undefined) data.cameraName = optionalString(body.cameraName);
    if (body?.cameraStableId !== undefined) data.cameraStableId = optionalString(body.cameraStableId);
    if (body?.cameraProfileId !== undefined) data.cameraProfileId = optionalString(body.cameraProfileId);
    if (body?.width !== undefined) data.width = requiredPositiveInt(body.width, "width");
    if (body?.height !== undefined) data.height = requiredPositiveInt(body.height, "height");
    if (body?.rotation !== undefined) {
      const rotation = Number(body.rotation);
      if (!isValidRotation(rotation)) {
        return badRequest("rotation must be one of 0, 90, 180, 270");
      }
      data.rotation = rotation;
    }
    if (body?.flipHorizontal !== undefined) data.flipHorizontal = body.flipHorizontal === true;
    if (body?.flipVertical !== undefined) data.flipVertical = body.flipVertical === true;
    if (body?.active !== undefined) data.active = body.active === true;
    if (body?.photoIntervalMinutes !== undefined) {
      data.photoIntervalMinutes = requiredPositiveInt(body.photoIntervalMinutes, "photoIntervalMinutes");
    }
    if (body?.captureStartAt !== undefined) data.captureStartAt = new Date(body.captureStartAt);
    if (body?.timeZone !== undefined) data.timeZone = requireValidTimeZone(body.timeZone);
    if (body?.captureWindowEnabled !== undefined) data.captureWindowEnabled = body.captureWindowEnabled === true;
    if (body?.captureWindowStartMinutes !== undefined) {
      data.captureWindowStartMinutes =
        body.captureWindowStartMinutes === null ? null : Number(body.captureWindowStartMinutes);
    }
    if (body?.captureWindowEndMinutes !== undefined) {
      data.captureWindowEndMinutes =
        body.captureWindowEndMinutes === null ? null : Number(body.captureWindowEndMinutes);
    }

    const source = await prisma.$transaction(async (tx) => {
      const updated = await tx.captureSource.update({ where: { id: sourceId }, data });
      const width = body?.assignmentWidth !== undefined ? requiredPositiveInt(body.assignmentWidth, "assignmentWidth") : undefined;
      const height = body?.assignmentHeight !== undefined ? requiredPositiveInt(body.assignmentHeight, "assignmentHeight") : undefined;
      const inputFormat = body?.inputFormat !== undefined ? normalizeCameraInputFormat(String(body.inputFormat)) : undefined;

      if (width !== undefined || height !== undefined || inputFormat !== undefined) {
        const activeAssignments = await tx.nodeCameraAssignment.findMany({
          where: { captureSourceId: sourceId, active: true },
          include: { nodeCamera: true },
        });
        for (const assignment of activeAssignments) {
          const nextWidth = width ?? assignment.width;
          const nextHeight = height ?? assignment.height;
          const nextFormat = inputFormat ?? assignment.inputFormat;
          const camera = { ...assignment.nodeCamera, formats: parseNodeCameraFormats(assignment.nodeCamera) };
          if (camera.formats.length > 0 && !cameraSupportsMode(camera, { inputFormat: nextFormat, width: nextWidth, height: nextHeight })) {
            throw new Error(`Camera does not advertise ${nextFormat.toUpperCase()} ${nextWidth}x${nextHeight}. Refresh inventory and choose a listed mode.`);
          }
        }

        const assignmentUpdate = await tx.nodeCameraAssignment.updateMany({
          where: { captureSourceId: sourceId, active: true },
          data: {
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(inputFormat !== undefined ? { inputFormat } : {}),
          },
        });

        if (updated.cameraProfileId && inputFormat !== undefined) {
          await tx.cameraProfile.update({
            where: { id: updated.cameraProfileId },
            data: {
              inputFormat,
              ...(width !== undefined ? { width } : {}),
              ...(height !== undefined ? { height } : {}),
            },
          });
        } else if (assignmentUpdate.count === 0 && inputFormat !== undefined) {
          const profile = await tx.cameraProfile.create({
            data: {
              name: `${updated.name} mode`,
              cameraDevice: updated.cameraDevice,
              cameraName: updated.cameraName,
              cameraStableId: updated.cameraStableId,
              width: width ?? updated.width,
              height: height ?? updated.height,
              inputFormat,
            },
          });
          return tx.captureSource.update({ where: { id: sourceId }, data: { cameraProfileId: profile.id } });
        }
      }

      return updated;
    });
    return NextResponse.json(source);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not update capture source");
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { sourceId } = await context.params;
  const existing = await prisma.captureSource.findUnique({ where: { id: sourceId } });
  if (!existing) {
    return notFound("Capture source not found");
  }

  await prisma.captureSource.delete({ where: { id: sourceId } });
  return NextResponse.json({ deleted: true });
}
