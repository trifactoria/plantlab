import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { reportSensorTestCommand, type SensorTestAttemptResult } from "@/lib/operations/sensorTestProtocol";
import { prisma } from "@/lib/prisma";

const ATTEMPTS_MAX = 20;

function parseAttempts(raw: unknown): SensorTestAttemptResult[] | null {
  if (!Array.isArray(raw) || raw.length > ATTEMPTS_MAX) return null;
  const attempts: SensorTestAttemptResult[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.attempt !== "number" || typeof record.classification !== "string") return null;
    attempts.push({
      attempt: record.attempt,
      classification: record.classification,
      code: typeof record.code === "string" ? record.code : null,
      message: typeof record.message === "string" ? record.message.slice(0, 500) : null,
      temperatureC: typeof record.temperatureC === "number" ? record.temperatureC : null,
      humidityPct: typeof record.humidityPct === "number" ? record.humidityPct : null,
    });
  }
  return attempts;
}

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const { commandId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const attempts = parseAttempts(body.attempts);
  if (attempts === null) {
    return NextResponse.json({ error: `attempts must be an array of at most ${ATTEMPTS_MAX} attempt objects.` }, { status: 400 });
  }
  if (typeof body.finalPass !== "boolean") {
    return NextResponse.json({ error: "finalPass must be a boolean." }, { status: 400 });
  }
  if (typeof body.attemptsCompleted !== "number" || typeof body.acceptedCount !== "number" || typeof body.failedCount !== "number") {
    return NextResponse.json({ error: "attemptsCompleted, acceptedCount, and failedCount must be numbers." }, { status: 400 });
  }

  const command = await reportSensorTestCommand(prisma, auth.node.id, commandId, {
    attemptsCompleted: body.attemptsCompleted,
    acceptedCount: body.acceptedCount,
    failedCount: body.failedCount,
    finalPass: body.finalPass,
    effectiveDriver: typeof body.effectiveDriver === "string" ? body.effectiveDriver : null,
    configuredGpio: typeof body.configuredGpio === "number" ? body.configuredGpio : null,
    attempts,
  });
  if (!command) {
    return NextResponse.json({ error: "No active sensor test with that id is available for this node." }, { status: 409 });
  }
  return NextResponse.json({ status: command.status, commandId: command.id });
}
