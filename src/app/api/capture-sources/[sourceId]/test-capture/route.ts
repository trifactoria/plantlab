import { NextResponse } from "next/server";
import { CameraBusyError } from "@/lib/cameraLock";
import { notFound } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
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
    const captured = await captureSourcePhoto(sourceId);
    const fanOut = await runViewportFanOut(captured.sourceCapture.id);

    return NextResponse.json({
      sourceCapture: captured.sourceCapture,
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
