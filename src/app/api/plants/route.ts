import { NextResponse } from "next/server";
import {
  badRequest,
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

    const plant = await prisma.plant.create({
      data: {
        projectId,
        name: requiredString(body?.name, "name"),
        tags: optionalString(body?.tags),
        notes: optionalString(body?.notes),
        gridX,
        gridY,
      },
    });

    return NextResponse.json(plant, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
