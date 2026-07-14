import { NextResponse } from "next/server";
import { nextServableJob, requireAgentAuth, serializeJobForAgent } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const job = await nextServableJob(prisma, auth.node.id);
  return NextResponse.json({ job: await serializeJobForAgent(prisma, job) });
}
