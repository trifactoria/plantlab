import { NextResponse } from "next/server";
import { badRequest, notFound, optionalString, readJson, requiredString } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ plantId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { plantId } = await context.params;
  const plant = await prisma.plant.findUnique({
    where: { id: plantId },
    include: {
      project: true,
      events: {
        include: { photo: true },
        orderBy: { timestamp: "desc" },
      },
    },
  });

  if (!plant) {
    return notFound("Plant not found");
  }

  return NextResponse.json(plant);
}

export async function PATCH(request: Request, context: Context) {
  const { plantId } = await context.params;
  const body = await readJson(request);

  try {
    const plant = await prisma.plant.update({
      where: { id: plantId },
      data: {
        name: body?.name === undefined ? undefined : requiredString(body.name, "name"),
        tags: body?.tags === undefined ? undefined : optionalString(body.tags),
        notes: body?.notes === undefined ? undefined : optionalString(body.notes),
      },
    });

    return NextResponse.json(plant);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    throw error;
  }
}
