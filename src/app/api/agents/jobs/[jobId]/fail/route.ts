import { NextResponse } from "next/server";
import { failJob, requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { jobId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const errorMessage = typeof body.error === "string" ? body.error : "Agent reported job failure.";
  const ok = await failJob(prisma, auth.node.id, jobId, errorMessage);
  if (!ok) {
    return NextResponse.json({ error: "No active job with that id is available for this node." }, { status: 409 });
  }

  return NextResponse.json({ status: "failed" });
}
