import { NextResponse } from "next/server";
import { CameraBusyError } from "@/lib/cameraLock";
import { readJson } from "@/lib/http";
import { localCameraHardwareEnabled } from "@/lib/localOnly";
import { captureProjectManually } from "@/lib/operations/projectManualCapture";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  const body = await readJson(request);

  try {
    const result = await captureProjectManually(prisma, projectId, {
      notes: typeof body?.notes === "string" ? body.notes : null,
      allowLocalHardware: localCameraHardwareEnabled(),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CameraBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    const message = error instanceof Error ? error.message : "Could not capture photo";
    const status =
      message.startsWith("Project not found") || message.includes("not found")
        ? 404
        : message.includes("physical camera hardware") || message.includes("Local physical camera hardware")
          ? 403
          : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
