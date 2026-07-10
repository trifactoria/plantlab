import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { badRequest, notFound, optionalDate, optionalString, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ photoId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { photoId } = await context.params;
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });

  if (!photo) {
    return notFound("Photo not found");
  }

  return NextResponse.json(photo);
}

export async function PATCH(request: Request, context: Context) {
  const { photoId } = await context.params;
  const body = await readJson(request);

  try {
    const photo = await prisma.photo.update({
      where: { id: photoId },
      data: {
        timestamp:
          body?.timestamp === undefined ? undefined : optionalDate(body.timestamp),
        notes: body?.notes === undefined ? undefined : optionalString(body.notes),
      },
    });

    return NextResponse.json(photo);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    throw error;
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { photoId } = await context.params;
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });

  if (!photo) {
    return notFound("Photo not found");
  }

  let fileDeleted = true;

  try {
    await unlink(photo.path);
  } catch (error) {
    fileDeleted = false;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ENOENT") {
      console.error(error);
    }
  }

  await prisma.$transaction([
    prisma.plantEvent.updateMany({
      where: { photoId },
      data: {
        cropX: null,
        cropY: null,
        cropWidth: null,
        cropHeight: null,
      },
    }),
    prisma.photo.delete({ where: { id: photoId } }),
  ]);

  return NextResponse.json({
    deleted: true,
    photoId,
    path: photo.path,
    fileDeleted,
  });
}
