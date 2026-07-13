import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { failPowerCommand } from "@/lib/operations/powerProtocol";
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

  const command = await failPowerCommand(prisma, auth.node.id, commandId, {
    actualState,
    stateObservedAt,
    errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
    errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : null,
  });
  if (!command) {
    return NextResponse.json({ error: "No active power command with that id is available for this node." }, { status: 409 });
  }
  return NextResponse.json({ status: "failed", commandId: command.id });
}
