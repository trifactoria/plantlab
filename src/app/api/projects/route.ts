import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  badRequest,
  optionalString,
  readJson,
  requiredPositiveInt,
  requiredString,
  serverError,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(projects);
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const localPhotoDirectory = requiredString(
      body?.localPhotoDirectory,
      "localPhotoDirectory",
    );

    try {
      await mkdir(localPhotoDirectory, { recursive: true });
    } catch (error) {
      console.error(error);
      return badRequest(`Could not create photo directory: ${localPhotoDirectory}`);
    }

    const project = await prisma.project.create({
      data: {
        name: requiredString(body?.name, "name"),
        description: optionalString(body?.description),
        gridWidth: requiredPositiveInt(body?.gridWidth, "gridWidth"),
        gridHeight: requiredPositiveInt(body?.gridHeight, "gridHeight"),
        photoIntervalMinutes: requiredPositiveInt(
          body?.photoIntervalMinutes,
          "photoIntervalMinutes",
        ),
        localPhotoDirectory,
      },
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
