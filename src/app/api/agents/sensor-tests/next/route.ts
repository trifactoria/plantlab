import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { nextSensorTestCommand } from "@/lib/operations/sensorTestProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const command = await nextSensorTestCommand(prisma, auth.node.id);
  return NextResponse.json({ command });
}
