import { NextResponse } from "next/server";
import { badRequest, readJson, requiredString, serverError } from "@/lib/http";
import { planCropPropagation, type PropagationTarget } from "@/lib/plantPhotoCropPropagation";
import { prisma } from "@/lib/prisma";

function parseTarget(value: unknown): PropagationTarget | null {
  if (value === "later-without-crop" || value === "all-without-crop") {
    return value;
  }

  return null;
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const plantId = requiredString(body?.plantId, "plantId");
    const sourcePhotoId = requiredString(body?.sourcePhotoId, "sourcePhotoId");
    const target = parseTarget(body?.target);

    if (!target) {
      return badRequest("target must be 'later-without-crop' or 'all-without-crop'");
    }

    const overwrite = body?.overwrite === true;
    const dryRun = body?.dryRun === true;

    const plant = await prisma.plant.findUnique({ where: { id: plantId } });
    if (!plant) {
      return badRequest("plantId is invalid");
    }

    const sourcePhoto = await prisma.photo.findUnique({ where: { id: sourcePhotoId } });
    if (!sourcePhoto || sourcePhoto.projectId !== plant.projectId) {
      return badRequest("sourcePhotoId is invalid for this plant's project.");
    }

    const [projectPhotos, existingCrops] = await Promise.all([
      prisma.photo.findMany({
        where: { projectId: plant.projectId },
        select: { id: true, timestamp: true },
      }),
      prisma.plantPhotoCrop.findMany({ where: { plantId }, select: { photoId: true } }),
    ]);

    const plan = planCropPropagation({
      target,
      sourcePhoto: { id: sourcePhoto.id, timestamp: sourcePhoto.timestamp },
      projectPhotos,
      existingCropPhotoIds: new Set(existingCrops.map((crop) => crop.photoId)),
      overwrite,
    });

    if (dryRun) {
      return NextResponse.json({
        affectedCount: plan.targetPhotoIds.length,
        skippedExistingCount: plan.skippedExistingCount,
      });
    }

    const sourceCrop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId, photoId: sourcePhotoId } },
    });

    if (!sourceCrop) {
      return badRequest("The source photo does not have a saved crop for this plant yet.");
    }

    const cropValues = {
      cropX: sourceCrop.cropX,
      cropY: sourceCrop.cropY,
      cropWidth: sourceCrop.cropWidth,
      cropHeight: sourceCrop.cropHeight,
    };

    for (const photoId of plan.targetPhotoIds) {
      await prisma.plantPhotoCrop.upsert({
        where: { plantId_photoId: { plantId, photoId } },
        create: {
          plantId,
          photoId,
          ...cropValues,
          createdMethod: "propagated",
          sourceCropId: sourceCrop.id,
        },
        update: {
          ...cropValues,
          createdMethod: "propagated",
          sourceCropId: sourceCrop.id,
        },
      });
    }

    return NextResponse.json({
      affectedCount: plan.targetPhotoIds.length,
      skippedExistingCount: plan.skippedExistingCount,
    });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
