import { NextResponse } from "next/server";
import { cropFromBody } from "@/lib/crops";
import { createCropVersionAndMaterialize, isCropAspectRatioMode } from "@/lib/cropVersions";
import { badRequest, notFound, readJson, requiredString, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ plantId: string }>;
};

/** Crop-version history for this plant, oldest first - used by "inspect crop versions". */
export async function GET(_request: Request, context: Context) {
  const { plantId } = await context.params;
  const plant = await prisma.plant.findUnique({ where: { id: plantId } });

  if (!plant) {
    return notFound("Plant not found");
  }

  const versions = await prisma.plantCropVersion.findMany({
    where: { plantId },
    orderBy: { effectiveFrom: "asc" },
  });

  return NextResponse.json({ versions });
}

/**
 * Shared endpoint behind both "Set initial crop" and "Adjust crop from this
 * frame forward" - see createCropVersionAndMaterialize for the exact
 * materialization rule. Always effective at the given source photo's
 * timestamp.
 */
export async function POST(request: Request, context: Context) {
  const { plantId } = await context.params;
  const body = await readJson(request);

  try {
    const plant = await prisma.plant.findUnique({ where: { id: plantId } });
    if (!plant) {
      return notFound("Plant not found");
    }

    const sourcePhotoId = requiredString(body?.sourcePhotoId, "sourcePhotoId");
    const sourcePhoto = await prisma.photo.findUnique({ where: { id: sourcePhotoId } });

    if (!sourcePhoto) {
      return badRequest("sourcePhotoId is invalid");
    }
    if (sourcePhoto.projectId !== plant.projectId) {
      return badRequest("sourcePhotoId belongs to a different project");
    }

    const crop = cropFromBody(body);
    if (!crop) {
      return badRequest("Crop bounds (cropX, cropY, cropWidth, cropHeight) are required.");
    }

    const aspectRatioMode = body?.aspectRatioMode;
    if (!isCropAspectRatioMode(aspectRatioMode)) {
      return badRequest("aspectRatioMode must be one of 1:1, 16:9, 9:16, free");
    }

    const result = await createCropVersionAndMaterialize(prisma, {
      plantId,
      projectId: plant.projectId,
      crop,
      aspectRatioMode,
      sourcePhotoId,
      effectiveFrom: sourcePhoto.timestamp,
    });

    if (plant.visualAspectRatio !== aspectRatioMode) {
      await prisma.plant.update({ where: { id: plantId }, data: { visualAspectRatio: aspectRatioMode } });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
