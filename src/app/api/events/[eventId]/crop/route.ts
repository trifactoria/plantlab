import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { eventHasCrop } from "@/lib/crops";
import { buildSharpResizeOptions, computeExtractRegion } from "@/lib/cropThumbnail";
import { badRequest, notFound, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ eventId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { eventId } = await context.params;
  const event = await prisma.plantEvent.findUnique({
    where: { id: eventId },
    include: { photo: true },
  });

  if (!event) {
    return notFound("Event not found");
  }

  if (!event.photo) {
    return badRequest("Event is not linked to a photo.");
  }

  if (!eventHasCrop(event)) {
    return badRequest("Event does not have a saved crop.");
  }

  try {
    const image = sharp(await readFile(event.photo.path));
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      return badRequest("Could not read source image dimensions.");
    }

    const region = computeExtractRegion(
      {
        cropX: event.cropX!,
        cropY: event.cropY!,
        cropWidth: event.cropWidth!,
        cropHeight: event.cropHeight!,
      },
      metadata.width,
      metadata.height,
    );

    const buffer = await sharp(await readFile(event.photo.path))
      .extract(region)
      .resize(buildSharpResizeOptions({ width: 320 }))
      .jpeg({ quality: 82 })
      .toBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      return notFound("Source image file is missing.");
    }

    return serverError(error);
  }
}
