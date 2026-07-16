import { NextResponse } from "next/server";
import { getFleetCamera } from "@/lib/operations/fleetHardware";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ cameraId: string }> }) {
  const { cameraId } = await context.params;
  const camera = await getFleetCamera(prisma, cameraId);
  if (!camera) {
    return NextResponse.json({ error: "Camera not found" }, { status: 404 });
  }
  return NextResponse.json({ camera });
}
