import { NextResponse } from "next/server";
import { listFleetSensors } from "@/lib/operations/fleetHardware";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const sensors = await listFleetSensors(prisma);
  return NextResponse.json({ sensors });
}
