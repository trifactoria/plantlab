import { NextResponse } from "next/server";
import {
  EVENT_KIND_OBSERVATION,
  originEventData,
  warningNeedsConfirmation,
} from "@/lib/experiment";
import {
  badRequest,
  optionalDate,
  optionalString,
  readJson,
  requiredGridIndex,
  requiredString,
  serverError,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId") ?? undefined;

  const plants = await prisma.plant.findMany({
    where: { projectId },
    orderBy: [{ gridY: "asc" }, { gridX: "asc" }],
  });

  return NextResponse.json(plants);
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const projectId = requiredString(body?.projectId, "projectId");
    const gridX = requiredGridIndex(body?.gridX, "gridX");
    const gridY = requiredGridIndex(body?.gridY, "gridY");
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      return badRequest("projectId is invalid");
    }

    if (gridX >= project.gridWidth || gridY >= project.gridHeight) {
      return badRequest("grid position is outside this project grid");
    }

    const name = requiredString(body?.name, "name");
    const tags = optionalString(body?.tags);
    const notes = optionalString(body?.notes);
    const startedAt = optionalDate(body?.startedAt);

    // The optional starting biological observation is an ordinary
    // PlantEvent, distinct from the required "Added to project" origin
    // event created below. It is not the same concept - see
    // isOriginEvent()/ORIGIN_EVENT_TYPE in src/lib/experiment.ts.
    const startingObservationBody =
      body?.startingObservation && typeof body.startingObservation === "object"
        ? (body.startingObservation as Record<string, unknown>)
        : null;
    const observationMilestoneId = startingObservationBody
      ? optionalString(startingObservationBody.milestoneId)
      : null;
    const observationType = startingObservationBody ? optionalString(startingObservationBody.type) : null;
    const observationNotes = startingObservationBody ? optionalString(startingObservationBody.notes) : null;
    const hasStartingObservation = Boolean(observationMilestoneId || observationType);

    let observationMilestone: { id: string; label: string; projectId: string } | null = null;
    if (observationMilestoneId) {
      observationMilestone = await prisma.projectMilestone.findUnique({
        where: { id: observationMilestoneId },
      });
      if (!observationMilestone) {
        return badRequest("startingObservation.milestoneId is invalid");
      }
      if (observationMilestone.projectId !== projectId) {
        return badRequest("startingObservation.milestoneId belongs to a different project");
      }
    }

    if (hasStartingObservation && !observationMilestone && !observationType) {
      return badRequest("startingObservation must include a milestoneId or a type");
    }

    const warnings: string[] = [];
    if (project.plantedAt && startedAt.getTime() < project.plantedAt.getTime()) {
      warnings.push("Starting timestamp is before the project planting time.");
    }
    if (warningNeedsConfirmation(warnings, body?.confirmWarnings === true)) {
      return NextResponse.json({ warnings }, { status: 409 });
    }

    const { plant, originEvent, observationEvent } = await prisma.$transaction(async (tx) => {
      const plant = await tx.plant.create({
        data: {
          projectId,
          name,
          tags,
          notes,
          gridX,
          gridY,
          startedAt,
        },
      });

      const originEvent = await tx.plantEvent.create({ data: originEventData(plant) });

      const observationEvent = hasStartingObservation
        ? await tx.plantEvent.create({
            data: {
              projectId: plant.projectId,
              plantId: plant.id,
              kind: EVENT_KIND_OBSERVATION,
              milestoneId: observationMilestone?.id,
              type: observationMilestone ? observationMilestone.label : (observationType as string),
              notes: observationNotes,
              timestamp: startedAt,
            },
          })
        : null;

      return { plant, originEvent, observationEvent };
    });

    return NextResponse.json(
      { ...plant, events: [originEvent, ...(observationEvent ? [observationEvent] : [])] },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
