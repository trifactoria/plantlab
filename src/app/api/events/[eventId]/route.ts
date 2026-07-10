import { NextResponse } from "next/server";
import { cropData, cropFromBody } from "@/lib/crops";
import {
  badRequest,
  notFound,
  optionalDate,
  optionalString,
  readJson,
  requiredString,
  serverError,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ eventId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { eventId } = await context.params;
  const event = await prisma.plantEvent.findUnique({
    where: { id: eventId },
    include: { plant: true, photo: true },
  });

  if (!event) {
    return notFound("Event not found");
  }

  return NextResponse.json(event);
}

export async function PATCH(request: Request, context: Context) {
  const { eventId } = await context.params;
  const body = await readJson(request);

  try {
    const existingEvent = await prisma.plantEvent.findUnique({
      where: { id: eventId },
    });

    if (!existingEvent) {
      return notFound("Event not found");
    }

    let nextPhotoId: string | null | undefined;
    let effectivePhotoId = existingEvent.photoId;
    if (body?.photoId !== undefined) {
      nextPhotoId = optionalString(body.photoId);
      effectivePhotoId = nextPhotoId;

      if (nextPhotoId) {
        const photo = await prisma.photo.findUnique({ where: { id: nextPhotoId } });

        if (!photo) {
          return badRequest("photoId is invalid");
        }

        if (photo.projectId !== existingEvent.projectId) {
          return badRequest("photoId belongs to a different project");
        }
      }
    }

    const crop = cropFromBody(body);
    if (crop && !effectivePhotoId) {
      return badRequest("A crop can only be saved when the event is linked to a photo.");
    }

    const nextCropData = nextPhotoId === null ? cropData(null) : cropData(crop);

    const event = await prisma.plantEvent.update({
      where: { id: eventId },
      data: {
        type: body?.type === undefined ? undefined : requiredString(body.type, "type"),
        notes: body?.notes === undefined ? undefined : optionalString(body.notes),
        timestamp:
          body?.timestamp === undefined
            ? undefined
            : optionalDate(body.timestamp, existingEvent.timestamp),
        photoId: nextPhotoId,
        ...nextCropData,
      },
    });

    return NextResponse.json(event);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { eventId } = await context.params;
  const event = await prisma.plantEvent.findUnique({ where: { id: eventId } });

  if (!event) {
    return notFound("Event not found");
  }

  await prisma.plantEvent.delete({ where: { id: eventId } });

  return NextResponse.json({ deleted: true, eventId });
}
