import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { contentTypeFor } from "@/lib/photos";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ photoId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { photoId } = await context.params;
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });

  if (!photo) {
    return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  }

  try {
    const image = await readFile(photo.path);

    return new Response(image, {
      headers: {
        "Content-Type": contentTypeFor(photo.filename),
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Image file is missing on disk" },
      { status: 404 },
    );
  }
}
