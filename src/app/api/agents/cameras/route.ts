import { NextResponse } from "next/server";
import {
  inventoryDiagnosticsForCamera,
  requireAgentAuth,
  updateCameraInventory,
  type AgentCameraInventoryItem,
} from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const body = (await request.json().catch(() => ({}))) as { cameras?: unknown };
  const cameras = Array.isArray(body.cameras) ? (body.cameras as AgentCameraInventoryItem[]) : [];
  const saved = await updateCameraInventory(prisma, auth.node.id, cameras);
  const assignments = await prisma.nodeCameraAssignment.findMany({
    where: { nodeId: auth.node.id, active: true },
    include: { nodeCamera: true, captureSource: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    status: "ok",
    cameras: saved.length,
    inventory: saved.map((camera) => ({
      stableId: camera.stableId,
      legacyStableId: camera.legacyStableId,
      devicePath: camera.devicePath,
      physicalPath: camera.physicalPath,
      usbPath: camera.usbPath,
      usbPort: camera.usbPort,
      ...inventoryDiagnosticsForCamera(camera),
    })),
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      name: assignment.name,
      captureSourceName: assignment.captureSource.name,
      captureSourceId: assignment.captureSourceId,
      stableId: assignment.nodeCamera.stableId,
      width: assignment.width,
      height: assignment.height,
      inputFormat: assignment.inputFormat,
    })),
  });
}
