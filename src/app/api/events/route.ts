import { NextResponse } from "next/server";
import { cropData, cropFromBody } from "@/lib/crops";
import { warningNeedsConfirmation } from "@/lib/experiment";
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

    const requestedCrop = cropFromBody(body);
    let crop = requestedCrop;
    if (!crop && body?.copyPlantPhotoCrop === true && photoId) {
      const plantPhotoCrop = await prisma.plantPhotoCrop.findUnique({
        where: { plantId_photoId: { plantId, photoId } },
        select: { cropX: true, cropY: true, cropWidth: true, cropHeight: true },
      });
      crop = plantPhotoCrop ?? undefined;
    }

    if (crop && !photoId) {
      return badRequest("A crop can only be saved when the event is linked to a photo.");
    }

    const milestoneId = optionalString(body?.milestoneId);
    const milestone = milestoneId
      ? await prisma.projectMilestone.findUnique({ where: { id: milestoneId } })
      : null;

    if (milestoneId && !milestone) {
      return badRequest("milestoneId is invalid");
    }

    if (milestone && milestone.projectId !== plant.projectId) {
      return badRequest("milestoneId belongs to a different project");
    }

    const timestamp = optionalDate(body?.timestamp, photo?.timestamp ?? new Date());
    const warnings: string[] = [];
    const project = await prisma.project.findUnique({ where: { id: plant.projectId } });
    if (project?.plantedAt && timestamp.getTime() < project.plantedAt.getTime()) {
      warnings.push("Event timestamp is before the project planting time.");
    }
    if (milestone) {
      const duplicate = await prisma.plantEvent.findFirst({
        where: { plantId, milestoneId: milestone.id },
      });
      if (duplicate) {
        warnings.push("This plant already has this milestone.");
      }
    }

    if (warningNeedsConfirmation(warnings, body?.confirmWarnings === true)) {
      return NextResponse.json({ warnings }, { status: 409 });
    }

    const event = await prisma.plantEvent.create({
      data: {
        projectId: plant.projectId,
        plantId,
        photoId,
        milestoneId: milestone?.id,
        type: milestone ? milestone.label : requiredString(body?.type, "type"),
        notes: optionalString(body?.notes),
        timestamp,
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
