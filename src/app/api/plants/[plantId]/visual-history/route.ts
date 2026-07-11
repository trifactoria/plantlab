import { NextResponse } from "next/server";
import { computeVisualHistoryStatus } from "@/lib/cropVersions";
import { notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ plantId: string }>;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseBoundedInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

/**
 * Lightweight, paginated index of a plant's visual-history frames - just
 * photo id and timestamp per frame, ordered chronologically. Kept small on
 * purpose (no thumbnails, notes, or events here) so it stays cheap even for
 * a plant with thousands of frames; the client fetches per-frame detail
 * lazily via the /frame endpoint as the user scrubs.
 */
export async function GET(request: Request, context: Context) {
  const { plantId } = await context.params;
  const plant = await prisma.plant.findUnique({ where: { id: plantId } });

  if (!plant) {
    return notFound("Plant not found");
  }

  const { searchParams } = new URL(request.url);
  const limit = parseBoundedInt(searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const offset = parseBoundedInt(searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);

  const [totalCount, crops, status] = await Promise.all([
    prisma.plantPhotoCrop.count({ where: { plantId } }),
    prisma.plantPhotoCrop.findMany({
      where: { plantId },
      orderBy: [{ photo: { timestamp: "asc" } }, { photoId: "asc" }],
      skip: offset,
      take: limit,
      select: { photoId: true, photo: { select: { timestamp: true } } },
    }),
    computeVisualHistoryStatus(prisma, plantId),
  ]);

  const frames = crops.map((crop) => ({
    photoId: crop.photoId,
    timestamp: crop.photo.timestamp.toISOString(),
  }));

  return NextResponse.json({
    frames,
    totalCount,
    offset,
    limit,
    hasMore: offset + frames.length < totalCount,
    status,
  });
}
