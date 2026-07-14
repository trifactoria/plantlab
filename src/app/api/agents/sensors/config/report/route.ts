import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { reportAppliedSensorConfig, type SensorConfigApplyReport } from "@/lib/operations/sensorConfig";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as SensorConfigApplyReport;
  if (typeof body.revision !== "number" || (body.status !== "applied" && body.status !== "rejected")) {
    return NextResponse.json({ error: "revision and status=applied|rejected are required." }, { status: 400 });
  }
  try {
    const result = await reportAppliedSensorConfig(prisma, auth.node.id, body);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
