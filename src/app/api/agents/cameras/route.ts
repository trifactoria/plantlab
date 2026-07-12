import { NextResponse } from "next/server";
import { requireAgentAuth, updateCameraInventory, type AgentCameraInventoryItem } from "@/lib/operations/agentProtocol";
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
