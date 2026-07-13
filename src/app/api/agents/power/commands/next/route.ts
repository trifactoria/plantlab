import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { nextPowerCommand } from "@/lib/operations/powerProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const command = await nextPowerCommand(prisma, auth.node.id);
  return NextResponse.json({ command });
}
