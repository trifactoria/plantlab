import { NextResponse } from "next/server";
import { nextQueuedJob, requireAgentAuth, serializeJobForAgent } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const job = await nextQueuedJob(prisma, auth.node.id);
  return NextResponse.json({ job: await serializeJobForAgent(prisma, job) });
}
