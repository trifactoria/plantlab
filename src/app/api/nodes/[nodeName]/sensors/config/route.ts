import { NextResponse } from "next/server";
import { createDesiredSensorConfigRevision, getSensorConfiguration, mutateSensorConfiguration, type DesiredSensorEntry } from "@/lib/operations/sensorConfig";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const config = await getSensorConfiguration(prisma, nodeName);
  if (!config) return NextResponse.json({ error: "Node not found." }, { status: 404 });
  return NextResponse.json(config);
}

export async function POST(request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (Array.isArray(body.entries)) {
      const revision = await createDesiredSensorConfigRevision(prisma, nodeName, body.entries as DesiredSensorEntry[], { requestedBy: "api" });
      return NextResponse.json({ status: "ok", revision: revision.revision });
    }
    const op = typeof body.op === "string" ? body.op : "";
    const sensorKey = typeof body.sensorKey === "string" ? body.sensorKey : "";
    const revision = await mutateSensorConfiguration(prisma, nodeName, { op, sensorKey, value: body.value } as Parameters<typeof mutateSensorConfiguration>[2], { requestedBy: "api" });
    return NextResponse.json({ status: "ok", revision: revision.revision });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
