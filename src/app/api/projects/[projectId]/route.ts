import { NextResponse } from "next/server";
import {
  badRequest,
  notFound,
  optionalString,
  readJson,
  requiredPositiveInt,
  requiredString,
  serverError,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      plants: true,
      photos: { orderBy: { timestamp: "desc" } },
    },
  });

  if (!project) {
    return notFound("Project not found");
  }

  return NextResponse.json(project);
}

export async function PATCH(request: Request, context: Context) {
  const { projectId } = await context.params;
  const body = await readJson(request);

  try {
    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: body?.name === undefined ? undefined : requiredString(body.name, "name"),
        description:
          body?.description === undefined ? undefined : optionalString(body.description),
        gridWidth:
          body?.gridWidth === undefined
            ? undefined
            : requiredPositiveInt(body.gridWidth, "gridWidth"),
        gridHeight:
          body?.gridHeight === undefined
            ? undefined
            : requiredPositiveInt(body.gridHeight, "gridHeight"),
        photoIntervalMinutes:
          body?.photoIntervalMinutes === undefined
            ? undefined
            : requiredPositiveInt(
                body.photoIntervalMinutes,
                "photoIntervalMinutes",
              ),
        localPhotoDirectory:
          body?.localPhotoDirectory === undefined
            ? undefined
            : requiredString(body.localPhotoDirectory, "localPhotoDirectory"),
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
