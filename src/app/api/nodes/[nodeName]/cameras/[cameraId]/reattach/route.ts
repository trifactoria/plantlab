import { NextResponse } from "next/server";
import { listCameraReattachCandidates, reattachNodeCamera } from "@/lib/operations/nodeCameras";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string; cameraId: string }> }) {
  const { nodeName, cameraId } = await context.params;
  try {
    const candidates = await listCameraReattachCandidates(prisma, { nodeName, cameraId });
    return NextResponse.json({ candidates });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ nodeName: string; cameraId: string }> }) {
  const { nodeName, cameraId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const endpointId = typeof body.endpointId === "string" ? body.endpointId : "";
  if (!endpointId) return NextResponse.json({ error: "endpointId is required." }, { status: 400 });
  try {
    const result = await reattachNodeCamera(prisma, { nodeName, cameraId, endpointId, force: body.force === true, requestedBy: "api" });
    return NextResponse.json({ status: "ok", ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
