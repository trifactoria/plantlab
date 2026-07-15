import { NextResponse } from "next/server";
import { configureFleetCamera } from "@/lib/operations/fleetHardware";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ cameraId: string }> }) {
  const { cameraId } = await context.params;
  try {
    const body = await request.json();
    const camera = await configureFleetCamera(prisma, { ...body, cameraId });
    return NextResponse.json({ status: "ok", cameraId: camera.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
