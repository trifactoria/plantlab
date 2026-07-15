import { NextResponse } from "next/server";
import { testFleetCameraCapture } from "@/lib/operations/fleetHardware";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await testFleetCameraCapture(prisma, {
      cameraId: typeof body.cameraId === "string" ? body.cameraId : undefined,
      captureSourceId: typeof body.captureSourceId === "string" ? body.captureSourceId : undefined,
      assignmentId: typeof body.assignmentId === "string" ? body.assignmentId : undefined,
      waitForCompletion: body.waitForCompletion === true,
    });
    return NextResponse.json({ status: "ok", result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
