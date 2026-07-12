import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { claimJob, requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { jobId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const captureId = typeof body.captureId === "string" && body.captureId.trim() ? body.captureId.trim() : randomUUID();
  const job = await claimJob(prisma, auth.node.id, jobId, captureId);
  if (!job) {
    return NextResponse.json({ error: "No queued job with that id is available for this node." }, { status: 409 });
  }

  return NextResponse.json({ status: "claimed", captureId });
}
