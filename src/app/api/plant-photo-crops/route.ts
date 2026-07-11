import { NextResponse } from "next/server";
import { cropFromBody } from "@/lib/crops";
import { badRequest, readJson, requiredString, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

const VISUAL_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "free"]);

function parseVisualAspectRatio(value: unknown) {
  return typeof value === "string" && VISUAL_ASPECT_RATIOS.has(value) ? value : null;
}

function inferVisualAspectRatio(crop: { cropWidth: number; cropHeight: number }) {
  return crop.cropWidth >= crop.cropHeight ? "16:9" : "9:16";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const plantId = searchParams.get("plantId") ?? undefined;
  const photoId = searchParams.get("photoId") ?? undefined;

  if (plantId && photoId) {
    const crop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId, photoId } },
    });

    return NextResponse.json({ crop });
  }

  const crops = await prisma.plantPhotoCrop.findMany({
    where: { plantId, photoId },
    include: { plant: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ crops });
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const plantId = requiredString(body?.plantId, "plantId");
    const photoId = requiredString(body?.photoId, "photoId");

    const [plant, photo] = await Promise.all([
      prisma.plant.findUnique({ where: { id: plantId } }),
      prisma.photo.findUnique({ where: { id: photoId } }),
    ]);

    if (!plant) {
      return badRequest("plantId is invalid");
    }

    if (!photo) {
      return badRequest("photoId is invalid");
    }

    if (plant.projectId !== photo.projectId) {
      return badRequest("Plant and photo must belong to the same project.");
    }

    const crop = cropFromBody(body);

    if (!crop) {
      return badRequest("Crop bounds (cropX, cropY, cropWidth, cropHeight) are required.");
    }

    const requestedAspectRatio = parseVisualAspectRatio(body?.visualAspectRatio);
    const nextPlantAspectRatio = requestedAspectRatio ?? plant.visualAspectRatio ?? inferVisualAspectRatio(crop);

    const saved = await prisma.$transaction(async (tx) => {
      const cropRow = await tx.plantPhotoCrop.upsert({
        where: { plantId_photoId: { plantId, photoId } },
        create: { plantId, photoId, ...crop, createdMethod: "manual" },
        update: { ...crop, createdMethod: "manual", sourceCropId: null },
      });

      if (plant.visualAspectRatio !== nextPlantAspectRatio) {
        await tx.plant.update({
          where: { id: plantId },
          data: { visualAspectRatio: nextPlantAspectRatio },
        });
      }

      return cropRow;
    });

    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
