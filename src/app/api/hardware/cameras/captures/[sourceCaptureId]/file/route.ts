import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Read-only image serving for a full-frame SourceCapture, used to preview the
 * result of a camera test capture (which returns a sourceCaptureId). Mirrors
 * the project photo file route; never mutates anything.
 */
export async function GET(_request: Request, context: { params: Promise<{ sourceCaptureId: string }> }) {
  const { sourceCaptureId } = await context.params;
  const capture = await prisma.sourceCapture.findUnique({ where: { id: sourceCaptureId } });
  if (!capture) {
    return NextResponse.json({ error: "Source capture not found" }, { status: 404 });
  }
  try {
    const image = await readFile(capture.originalPath);
    return new Response(image, {
      headers: {
        "Content-Type": capture.mimeType ?? "image/jpeg",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return NextResponse.json({ error: "Image file is missing on disk" }, { status: 404 });
  }
}
