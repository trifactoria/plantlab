import path from "node:path";
import { NextResponse } from "next/server";
import {
  badRequest,
  optionalDate,
  optionalString,
  readJson,
  requiredString,
  serverError,
} from "@/lib/http";
import { buildPhotoPath } from "@/lib/photos";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId") ?? undefined;

  const photos = await prisma.photo.findMany({
    where: { projectId },
    orderBy: { timestamp: "desc" },
  });

  return NextResponse.json(photos);
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const projectId = requiredString(body?.projectId, "projectId");
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      return badRequest("projectId is invalid");
    }

    const incomingPath = requiredString(body?.path ?? body?.filename, "path");
    const photoPath = buildPhotoPath(project.localPhotoDirectory, incomingPath);
    const filename =
      typeof body?.filename === "string" && body.filename.trim().length > 0
        ? body.filename.trim()
        : path.basename(photoPath);

    const photo = await prisma.photo.create({
      data: {
        projectId,
        filename,
        path: photoPath,
        timestamp: optionalDate(body?.timestamp),
        notes: optionalString(body?.notes),
      },
    });

    return NextResponse.json(photo, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
