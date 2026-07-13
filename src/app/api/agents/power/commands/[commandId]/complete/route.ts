import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { completePowerCommand } from "@/lib/operations/powerProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { commandId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const actualState = typeof body.actualState === "boolean" ? body.actualState : body.actualState === null ? null : undefined;
  const stateObservedAt = typeof body.stateObservedAt === "string" && body.stateObservedAt.trim() ? new Date(body.stateObservedAt) : null;
  if (stateObservedAt && Number.isNaN(stateObservedAt.getTime())) {
    return NextResponse.json({ error: "stateObservedAt must be a valid ISO 8601 timestamp." }, { status: 400 });
  }

  const command = await completePowerCommand(prisma, auth.node.id, commandId, { actualState, stateObservedAt });
  if (!command) {
    return NextResponse.json({ error: "No claimed power command with that id is available for this node." }, { status: 409 });
  }
  return NextResponse.json({ status: "succeeded", commandId: command.id, actualState: command.actualState });
}
