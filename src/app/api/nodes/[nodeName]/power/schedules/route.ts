import { NextResponse } from "next/server";
import { createPowerSchedule, listPowerSchedules } from "@/lib/operations/powerSchedule";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const schedules = await listPowerSchedules(prisma, nodeName);
  if (!schedules) {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }
  return NextResponse.json({ schedules });
}

export async function POST(request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const body = await request.json().catch(() => ({}));
  const result = await createPowerSchedule(prisma, nodeName, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ schedule: result.schedule }, { status: result.status });
}
