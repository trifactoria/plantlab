import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { desiredSensorConfigForAgent } from "@/lib/operations/sensorConfig";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;
  const desired = await desiredSensorConfigForAgent(prisma, auth.node.id);
  return NextResponse.json({ desired });
}
