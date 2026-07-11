import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { computeExtractRegion, resolveThumbnailSize } from "@/lib/cropThumbnail";
import { badRequest, notFound, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ cropId: string }>;
};

export async function GET(request: Request, context: Context) {
  const { cropId } = await context.params;
  const { searchParams } = new URL(request.url);
  const size = resolveThumbnailSize(searchParams.get("size"));

  const crop = await prisma.plantPhotoCrop.findUnique({
    where: { id: cropId },
    include: { photo: true },
  });

  if (!crop) {
    return notFound("Crop not found");
  }

  try {
    const fileBuffer = await readFile(crop.photo.path);
    const metadata = await sharp(fileBuffer).metadata();

    if (!metadata.width || !metadata.height) {
      return badRequest("Could not read source image dimensions.");
    }

    const region = computeExtractRegion(crop, metadata.width, metadata.height);

    if (region.width <= 0 || region.height <= 0) {
      return badRequest("Crop region is invalid for this photo.");
    }

    const buffer = await sharp(fileBuffer)
      .extract(region)
      .resize({ width: size, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/webp",
        // The source photo file never changes, and callers key the URL's
        // "v" query param on this crop's updatedAt - so a given URL really
        // is immutable; editing the crop produces a new URL instead.
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${crop.id}-${crop.updatedAt.getTime()}"`,
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
