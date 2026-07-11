import { NextResponse } from "next/server";
import { HARVESTED_MILESTONE_KEY, warningNeedsConfirmation } from "@/lib/experiment";
import { badRequest, notFound, nullableDate, optionalString, readJson, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ plantId: string }>;
};

function optionalNumber(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a number`);
  }
  return parsed;
}

function optionalScore(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("flavorScore must be between 1 and 10");
  }
  return parsed;
}

export async function GET(_request: Request, context: Context) {
  const { plantId } = await context.params;
  const result = await prisma.plantHarvestResult.findUnique({ where: { plantId } });
  return NextResponse.json({ result });
}

export async function PUT(request: Request, context: Context) {
  const { plantId } = await context.params;
  const body = await readJson(request);

  try {
    const plant = await prisma.plant.findUnique({
      where: { id: plantId },
      include: {
        project: true,
        events: { include: { milestone: true } },
      },
    });

    if (!plant) {
      return notFound("Plant not found");
    }

    const harvestedAt = nullableDate(body?.harvestedAt, "harvestedAt");
    if (!harvestedAt) {
      return badRequest("harvestedAt is required");
    }

    const warnings: string[] = [];
    if (harvestedAt.getTime() < plant.startedAt.getTime()) {
      warnings.push("Harvested date is before this plant's start date.");
    }
    const hasHarvestedEvent = plant.events.some(
      (event) =>
        event.milestone?.key === HARVESTED_MILESTONE_KEY ||
        event.type.trim().toLowerCase() === "harvested",
    );
    if (!hasHarvestedEvent) {
      warnings.push("This plant has a harvest result without a Harvested event.");
    }

    if (warningNeedsConfirmation(warnings, body?.confirmWarnings === true)) {
      return NextResponse.json({ warnings }, { status: 409 });
    }

    const result = await prisma.plantHarvestResult.upsert({
      where: { plantId },
      create: {
        plantId,
        harvestedAt,
        rootWeightGrams: optionalNumber(body?.rootWeightGrams, "rootWeightGrams"),
        rootDiameterMm: optionalNumber(body?.rootDiameterMm, "rootDiameterMm"),
        rootLengthMm: optionalNumber(body?.rootLengthMm, "rootLengthMm"),
        split: body?.split === true,
        bolted: body?.bolted === true,
        damaged: body?.damaged === true,
        acceptable: body?.acceptable !== false,
        flavorScore: optionalScore(body?.flavorScore),
        selectedForSeed: body?.selectedForSeed === true,
        notes: optionalString(body?.notes),
      },
      update: {
        harvestedAt,
        rootWeightGrams: optionalNumber(body?.rootWeightGrams, "rootWeightGrams"),
        rootDiameterMm: optionalNumber(body?.rootDiameterMm, "rootDiameterMm"),
        rootLengthMm: optionalNumber(body?.rootLengthMm, "rootLengthMm"),
        split: body?.split === true,
        bolted: body?.bolted === true,
        damaged: body?.damaged === true,
        acceptable: body?.acceptable !== false,
        flavorScore: optionalScore(body?.flavorScore),
        selectedForSeed: body?.selectedForSeed === true,
        notes: optionalString(body?.notes),
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
