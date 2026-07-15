import { NextResponse } from "next/server";
import { notFound } from "@/lib/http";
import { requestCameraInventoryRefresh } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ sourceId: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: {
      assignments: {
        where: { active: true, nodeCamera: { available: true, enabled: true, retiredAt: null } },
        include: { node: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });

  if (!source) return notFound("Capture source not found");
  const assignment = source.assignments[0];
  if (!assignment) {
    return NextResponse.json({ error: "This shelf camera is not assigned to a remote node." }, { status: 400 });
  }

  const node = await requestCameraInventoryRefresh(prisma, assignment.node.name);
  return NextResponse.json({
    status: "requested",
    nodeName: node.name,
    requestedAt: node.inventoryRefreshRequestedAt?.toISOString() ?? null,
  });
}
