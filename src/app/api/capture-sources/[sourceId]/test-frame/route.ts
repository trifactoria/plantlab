import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { CameraBusyError } from "@/lib/cameraLock";
import { notFound } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { applyOrientation, parseRotation } from "@/lib/orientation";
import { prisma } from "@/lib/prisma";
import { captureSourcePhoto } from "@/lib/sourceCapture";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ sourceId: string }>;
};

/**
 * Captures one manual (non-scheduled) full-resolution test frame from this
 * capture source and returns it already transformed (rotation/flip
 * applied) so the shelf layout editor can draw viewport rectangles directly
 * against the same working frame that viewport coordinates are normalized
 * to. The original file on disk is left untouched by this transform - only
 * the returned preview bytes are rotated/flipped.
 */
export async function POST(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({ where: { id: sourceId } });
  if (!source) {
    return notFound("Capture source not found");
  }

  try {
    const { sourceCapture, savedPath } = await captureSourcePhoto(sourceId);
    const rawBuffer = await readFile(savedPath);
    const oriented = await applyOrientation(sharp(rawBuffer), {
      rotation: parseRotation(source.rotation),
      flipHorizontal: source.flipHorizontal,
      flipVertical: source.flipVertical,
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    return NextResponse.json({
      sourceCapture,
      workingWidth: sourceCapture.workingWidth,
      workingHeight: sourceCapture.workingHeight,
      imageBase64: oriented.toString("base64"),
    });
  } catch (error) {
    if (error instanceof CameraBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    const message = error instanceof Error ? error.message : "Could not capture test frame";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
