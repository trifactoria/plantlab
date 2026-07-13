import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { CameraBusyError } from "@/lib/cameraLock";
import { notFound } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { applyOrientation, parseRotation } from "@/lib/orientation";
import { createManualCaptureJob, waitForJobCompletion } from "@/lib/operations/manualCapture";
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
  const source = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: {
      assignments: {
        where: { active: true },
        include: { node: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!source) {
    return notFound("Capture source not found");
  }

  try {
    const assignment = source.assignments[0];
    if (assignment) {
      const { job } = await createManualCaptureJob(prisma, { nodeName: assignment.node.name, assignmentId: assignment.id });
      const completed = await waitForJobCompletion(prisma, job.id, { timeoutMs: 120_000, pollMs: 1000 });
      if (!completed) {
        throw new Error("Remote capture timed out before the agent completed the job.");
      }
      if (completed.status === "failed") {
        throw new Error(completed.errorMessage ?? "Remote capture failed.");
      }
      if (completed.status !== "completed" || !completed.sourceCaptureId) {
        throw new Error(`Remote capture ended in unexpected state: ${completed.status}.`);
      }
      const sourceCapture = await prisma.sourceCapture.findUniqueOrThrow({ where: { id: completed.sourceCaptureId } });
      const rawBuffer = await readFile(sourceCapture.originalPath);
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
    }

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
