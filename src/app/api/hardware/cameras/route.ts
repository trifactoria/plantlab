import { NextResponse } from "next/server";
import { listFleetCameras } from "@/lib/operations/fleetHardware";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const cameras = await listFleetCameras(prisma);
  return NextResponse.json({ cameras });
}
