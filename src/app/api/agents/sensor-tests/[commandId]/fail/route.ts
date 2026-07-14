import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { failSensorTestCommand } from "@/lib/operations/sensorTestProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { commandId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const errorCode = typeof body.errorCode === "string" ? body.errorCode : "sensor-test-failed";
  const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage : "Sensor test failed.";

  const command = await failSensorTestCommand(prisma, auth.node.id, commandId, errorCode, errorMessage);
  if (!command) {
    return NextResponse.json({ error: "No active sensor test with that id is available for this node." }, { status: 409 });
  }
  return NextResponse.json({ status: "failed", commandId: command.id });
}
