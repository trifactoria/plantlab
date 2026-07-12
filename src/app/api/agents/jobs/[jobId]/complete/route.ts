import { NextResponse } from "next/server";
import { completeJob, requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { jobId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const captureId = typeof body.captureId === "string" ? body.captureId.trim() : "";
  if (!captureId) {
    return NextResponse.json({ error: "captureId is required." }, { status: 400 });
  }

  const result = await completeJob(prisma, auth.node.id, jobId, captureId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    status: "completed",
    sourceCaptureId: result.sourceCapture.id,
    captureId: result.sourceCapture.captureId,
  });
}
