import { NextResponse } from "next/server";
import { createSensorTestCommand, serializeSensorTestCommand } from "@/lib/operations/sensorTestProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ nodeName: string; sensorKey: string }> }) {
  const { nodeName, sensorKey } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const result = await createSensorTestCommand(prisma, nodeName, {
    sensorKey,
    attempts: typeof body.attempts === "number" ? body.attempts : undefined,
    intervalSeconds: typeof body.intervalSeconds === "number" ? body.intervalSeconds : undefined,
    requestedBy: "browser",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, command: result.command ? serializeSensorTestCommand(result.command) : null }, { status: result.status });
  }
  return NextResponse.json({ command: serializeSensorTestCommand(result.command) }, { status: result.status });
}
