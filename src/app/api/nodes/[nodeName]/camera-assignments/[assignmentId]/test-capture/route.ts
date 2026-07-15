import { NextResponse } from "next/server";
import { testFleetCameraCapture } from "@/lib/operations/fleetHardware";
import { prisma } from "@/lib/prisma";

export async function POST(_request: Request, context: { params: Promise<{ nodeName: string; assignmentId: string }> }) {
  const { nodeName, assignmentId } = await context.params;
  try {
    const result = await testFleetCameraCapture(prisma, { nodeName, assignmentId });
    return NextResponse.json({ status: "ok", jobId: result.jobId, reused: result.reused, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
