import { NextResponse } from "next/server";
import { deletePowerSchedule, updatePowerSchedule } from "@/lib/operations/powerSchedule";
import { prisma } from "@/lib/prisma";

export async function PATCH(request: Request, context: { params: Promise<{ nodeName: string; scheduleId: string }> }) {
  const { nodeName, scheduleId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const result = await updatePowerSchedule(prisma, nodeName, scheduleId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ schedule: result.schedule }, { status: result.status });
}

export async function DELETE(_request: Request, context: { params: Promise<{ nodeName: string; scheduleId: string }> }) {
  const { nodeName, scheduleId } = await context.params;
  const result = await deletePowerSchedule(prisma, nodeName, scheduleId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true }, { status: result.status });
}
