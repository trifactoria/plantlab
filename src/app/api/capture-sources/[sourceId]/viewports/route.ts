import { NextResponse } from "next/server";
import { cropFromBody } from "@/lib/crops";
import { badRequest, notFound, optionalDate, optionalString, readJson, requiredString } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { findOverlappingPairs } from "@/lib/viewportGeometry";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ sourceId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({ where: { id: sourceId } });
  if (!source) {
    return notFound("Capture source not found");
  }

  const viewports = await prisma.projectViewport.findMany({
    where: { captureSourceId: sourceId, active: true },
    orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
    distinct: ["projectId"],
    include: { project: { select: { id: true, name: true } } },
  });

  const overlaps = findOverlappingPairs(viewports.map((v) => ({ id: v.id, cropX: v.cropX, cropY: v.cropY, cropWidth: v.cropWidth, cropHeight: v.cropHeight })));

  return NextResponse.json({
    viewports,
    overlappingViewportIds: Array.from(new Set(overlaps.flatMap(([a, b]) => [a.id, b.id]))),
  });
}

/**
 * Creates a new ProjectViewport version for a project on this source,
 * effective from the given (or current) timestamp forward - mirrors crop
 * version creation exactly: this never edits an existing viewport row, so
 * project photos already generated under an earlier viewport are
 * unaffected, and only captures at/after effectiveFrom resolve to the new
 * rectangle.
 */
export async function POST(request: Request, context: Context) {
  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({ where: { id: sourceId } });
  if (!source) {
    return notFound("Capture source not found");
  }

  const body = await readJson(request);

  try {
    const projectId = requiredString(body?.projectId, "projectId");
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return badRequest("Project not found");
    }

    const crop = cropFromBody(body);
    if (!crop) {
      return badRequest("Crop bounds (cropX, cropY, cropWidth, cropHeight) are required.");
    }

    const viewport = await prisma.projectViewport.create({
      data: {
        projectId,
        captureSourceId: sourceId,
        ...crop,
        effectiveFrom: optionalDate(body?.effectiveFrom),
        sourceCaptureId: optionalString(body?.sourceCaptureId),
        active: true,
      },
      include: { project: { select: { id: true, name: true } } },
    });

    return NextResponse.json(viewport, { status: 201 });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not create viewport");
  }
}
