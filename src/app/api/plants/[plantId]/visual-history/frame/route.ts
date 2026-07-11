import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/http";
import { computeExtractRegion } from "@/lib/cropThumbnail";
import { prisma } from "@/lib/prisma";
import sharp from "sharp";

type Context = {
  params: Promise<{ plantId: string }>;
};

/**
 * Full detail for a single visual-history frame, fetched lazily by the
 * client as the user scrubs/steps through frames (rather than bundling
 * every frame's notes/events/crop metadata into the index response).
 */
export async function GET(request: Request, context: Context) {
  const { plantId } = await context.params;
  const { searchParams } = new URL(request.url);
  const photoId = searchParams.get("photoId");

  if (!photoId) {
    return badRequest("photoId is required");
  }

  const crop = await prisma.plantPhotoCrop.findUnique({
    where: { plantId_photoId: { plantId, photoId } },
    include: { photo: true },
  });

  if (!crop) {
    return notFound("No saved crop for this plant and photo.");
  }

  const events = await prisma.plantEvent.findMany({
    where: { plantId, photoId },
    orderBy: { timestamp: "asc" },
  });

  let sourceCropWidth: number | null = null;
  let sourceCropHeight: number | null = null;
  try {
    const metadata = await sharp(crop.photo.path).metadata();
    if (metadata.width && metadata.height) {
      const region = computeExtractRegion(crop, metadata.width, metadata.height);
      sourceCropWidth = region.width;
      sourceCropHeight = region.height;
    }
  } catch {
    sourceCropWidth = null;
    sourceCropHeight = null;
  }

  return NextResponse.json({
    photo: {
      id: crop.photo.id,
      timestamp: crop.photo.timestamp,
      notes: crop.photo.notes,
    },
    crop: {
      id: crop.id,
      updatedAt: crop.updatedAt,
      cropX: crop.cropX,
      cropY: crop.cropY,
      cropWidth: crop.cropWidth,
      cropHeight: crop.cropHeight,
      createdMethod: crop.createdMethod,
      sourceCropId: crop.sourceCropId,
      sourceCropWidth,
      sourceCropHeight,
    },
    events,
  });
}
