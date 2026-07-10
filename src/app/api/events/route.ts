import { NextResponse } from "next/server";
import { cropData, cropFromBody } from "@/lib/crops";
import {
  badRequest,
  optionalDate,
  optionalString,
  readJson,
  requiredString,
  serverError,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId") ?? undefined;
  const plantId = searchParams.get("plantId") ?? undefined;
  const photoId = searchParams.get("photoId") ?? undefined;

  const events = await prisma.plantEvent.findMany({
    where: { projectId, plantId, photoId },
    include: { plant: true, photo: true },
    orderBy: { timestamp: "desc" },
  });

  return NextResponse.json(events);
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const plantId = requiredString(body?.plantId, "plantId");
    const plant = await prisma.plant.findUnique({ where: { id: plantId } });

    if (!plant) {
      return badRequest("plantId is invalid");
    }

    const photoId = optionalString(body?.photoId);
    const photo = photoId
      ? await prisma.photo.findUnique({ where: { id: photoId } })
      : null;

    if (photoId && !photo) {
      return badRequest("photoId is invalid");
    }

    if (photo && photo.projectId !== plant.projectId) {
      return badRequest("photoId belongs to a different project");
    }

    const crop = cropFromBody(body);
    if (crop && !photoId) {
      return badRequest("A crop can only be saved when the event is linked to a photo.");
    }

    const event = await prisma.plantEvent.create({
      data: {
        projectId: plant.projectId,
        plantId,
        photoId,
        type: requiredString(body?.type, "type"),
        notes: optionalString(body?.notes),
        timestamp: optionalDate(body?.timestamp, photo?.timestamp ?? new Date()),
        ...cropData(crop),
      },
    });

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
