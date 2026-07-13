import type { PrismaClient } from "@prisma/client";
import { computeNodeStatus, hasActiveCredential, type NodeStatusLabel } from "./nodeCredentials";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/coordinatorDashboard.ts is server-only operational code.");
}

export type CoordinatorNodeSummary = {
  id: string;
  name: string;
  role: string;
  statusLabel: NodeStatusLabel;
  lastHeartbeatAt: Date | null;
  cameraCount: number;
  /** Failed AgentCaptureJob rows for this node in the last 24h - a running total since day one would make an otherwise-healthy node look permanently broken. */
  recentFailedJobCount: number;
};

export type CoordinatorDashboardData = {
  jobQueue: { queued: number; claimed: number };
  nodes: CoordinatorNodeSummary[];
  /** Active CaptureSources not backed by any remote NodeCamera - i.e. ones that actually depend on the local pnpm camera:service scheduler. */
  activeLocalCaptureSourceCount: number;
};

const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getCoordinatorDashboardData(prisma: PrismaClient): Promise<CoordinatorDashboardData> {
  const since = new Date(Date.now() - RECENT_FAILURE_WINDOW_MS);

  const [nodes, queued, claimed, activeLocalCaptureSourceCount] = await Promise.all([
    prisma.plantLabNode.findMany({
      orderBy: { name: "asc" },
      include: { cameras: { select: { id: true, available: true } } },
    }),
    prisma.agentCaptureJob.count({ where: { status: "queued" } }),
    prisma.agentCaptureJob.count({ where: { status: "claimed" } }),
    prisma.captureSource.count({ where: { active: true, nodeCameras: { none: {} } } }),
  ]);

  const nodeSummaries = await Promise.all(
    nodes.map(async (node) => {
      const [activeCredential, recentFailedJobCount] = await Promise.all([
        hasActiveCredential(prisma, node.id),
        prisma.agentCaptureJob.count({ where: { nodeId: node.id, status: "failed", updatedAt: { gte: since } } }),
      ]);
      return {
        id: node.id,
        name: node.name,
        role: node.role,
        statusLabel: computeNodeStatus(node, activeCredential),
        lastHeartbeatAt: node.lastHeartbeatAt,
        // available=true means the agent's own real ffmpeg capture probe
        // succeeded (Part 5) - counting every enumerated device instead
        // made a Raspberry Pi's non-camera hardware codec/ISP devices show
        // up as if they were real, selectable cameras.
        cameraCount: node.cameras.filter((camera) => camera.available).length,
        recentFailedJobCount,
      };
    }),
  );

  return { jobQueue: { queued, claimed }, nodes: nodeSummaries, activeLocalCaptureSourceCount };
}
