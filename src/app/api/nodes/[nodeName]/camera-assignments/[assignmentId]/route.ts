import { NextResponse } from "next/server";
import { updateCameraAssignmentConfig } from "@/lib/operations/nodeCameras";
import { prisma } from "@/lib/prisma";

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumberOrUndefined(value: unknown) {
  return value === null ? null : numberOrUndefined(value);
}

export async function PATCH(request: Request, context: { params: Promise<{ nodeName: string; assignmentId: string }> }) {
  const { nodeName, assignmentId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const assignment = await updateCameraAssignmentConfig(prisma, {
      nodeName,
      assignmentId,
      width: typeof body.width === "number" ? body.width : undefined,
      height: typeof body.height === "number" ? body.height : undefined,
      inputFormat: typeof body.inputFormat === "string" ? body.inputFormat : undefined,
      frameRate: body.frameRate === null || typeof body.frameRate === "string" ? body.frameRate : undefined,
      warmupFrames: numberOrUndefined(body.warmupFrames),
      warmupSeconds: nullableNumberOrUndefined(body.warmupSeconds),
      captureAttempts: numberOrUndefined(body.captureAttempts),
      fallbackWidth: nullableNumberOrUndefined(body.fallbackWidth),
      fallbackHeight: nullableNumberOrUndefined(body.fallbackHeight),
      fallbackInputFormat: body.fallbackInputFormat === null || typeof body.fallbackInputFormat === "string" ? body.fallbackInputFormat : undefined,
      fallbackFrameRate: body.fallbackFrameRate === null || typeof body.fallbackFrameRate === "string" ? body.fallbackFrameRate : undefined,
      fallbackAttempts: numberOrUndefined(body.fallbackAttempts),
      serializeOnNode: typeof body.serializeOnNode === "boolean" ? body.serializeOnNode : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      requestedBy: "api",
    });
    return NextResponse.json({ status: "ok", assignment });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
