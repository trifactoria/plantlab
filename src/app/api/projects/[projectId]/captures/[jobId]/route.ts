import { NextResponse } from "next/server";
import { getProjectCaptureJobStatus } from "@/lib/operations/projectManualCapture";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string; jobId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { projectId, jobId } = await context.params;
  try {
    const result = await getProjectCaptureJobStatus(prisma, projectId, jobId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load capture job.";
    const status = message.startsWith("Project not found") || message.startsWith("Capture job not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
