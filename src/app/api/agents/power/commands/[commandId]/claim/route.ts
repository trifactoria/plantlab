import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { claimPowerCommand } from "@/lib/operations/powerProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { commandId } = await context.params;
  const command = await claimPowerCommand(prisma, auth.node.id, commandId);
  if (!command) {
    return NextResponse.json({ error: "No pending power command with that id is available for this node." }, { status: 409 });
  }
  return NextResponse.json({ status: "claimed", commandId: command.id });
}
