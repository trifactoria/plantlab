import { NextResponse } from "next/server";
import { CameraBusyError } from "@/lib/cameraLock";
import { notFound } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { createManualCaptureJob, waitForJobCompletion } from "@/lib/operations/manualCapture";
import { prisma } from "@/lib/prisma";
import { captureSourcePhoto } from "@/lib/sourceCapture";
import { runViewportFanOut } from "@/lib/viewportFanOut";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ sourceId: string }>;
};

/**
 * Triggers one manual (non-scheduled) fan-out capture: captures the source
 * once, then generates and registers one derived Photo per project with an
 * applicable active viewport. Used by the shelf layout editor's "Trigger
 * Test Capture" action to review the result of a layout before relying on
 * the schedule.
 */
export async function POST(_request: Request, context: Context) {
  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: {
      assignments: {
        where: { active: true, nodeCamera: { available: true, enabled: true, retiredAt: null } },
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
    let sourceCaptureId: string;
    if (assignment) {
      const { job } = await createManualCaptureJob(prisma, { nodeName: assignment.node.name, assignmentId: assignment.id });
      const completed = await waitForJobCompletion(prisma, job.id, { timeoutMs: 120_000, pollMs: 1000 });
      if (!completed) throw new Error("Remote capture timed out before the agent completed the job.");
      if (completed.status === "failed") throw new Error(completed.errorMessage ?? "Remote capture failed.");
      if (completed.status !== "completed" || !completed.sourceCaptureId) {
        throw new Error(`Remote capture ended in unexpected state: ${completed.status}.`);
      }
      sourceCaptureId = completed.sourceCaptureId;
    } else {
      const blocked = productionLocalOnlyResponse();
      if (blocked) {
        return blocked;
      }
      const captured = await captureSourcePhoto(sourceId);
      sourceCaptureId = captured.sourceCapture.id;
    }

    const fanOut = await runViewportFanOut(sourceCaptureId);
    const sourceCapture = await prisma.sourceCapture.findUniqueOrThrow({ where: { id: sourceCaptureId } });

    return NextResponse.json({
      sourceCapture,
      fanOut,
    });
  } catch (error) {
    if (error instanceof CameraBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    const message = error instanceof Error ? error.message : "Test capture failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
