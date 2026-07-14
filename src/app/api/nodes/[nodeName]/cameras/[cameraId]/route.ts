import { NextResponse } from "next/server";
import { renameNodeCamera, restoreNodeCamera, retireNodeCamera, setNodeCameraEnabled } from "@/lib/operations/nodeCameras";
import { prisma } from "@/lib/prisma";

export async function PATCH(request: Request, context: { params: Promise<{ nodeName: string; cameraId: string }> }) {
  const { nodeName, cameraId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (typeof body.name === "string") {
      const camera = await renameNodeCamera(prisma, { nodeName, cameraId, name: body.name, requestedBy: "api" });
      return NextResponse.json({ status: "ok", camera });
    }
    if (typeof body.enabled === "boolean") {
      const camera = await setNodeCameraEnabled(prisma, { nodeName, cameraId, enabled: body.enabled, requestedBy: "api" });
      return NextResponse.json({ status: "ok", camera });
    }
    if (body.retired === true) {
      const camera = await retireNodeCamera(prisma, { nodeName, cameraId, requestedBy: "api" });
      return NextResponse.json({ status: "ok", camera });
    }
    if (body.retired === false) {
      const camera = await restoreNodeCamera(prisma, { nodeName, cameraId, requestedBy: "api" });
      return NextResponse.json({ status: "ok", camera });
    }
    return NextResponse.json({ error: "No supported camera update was provided." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
