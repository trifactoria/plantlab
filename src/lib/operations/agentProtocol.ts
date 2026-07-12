import type { PrismaClient } from "@prisma/client";
import type { CameraFormat } from "../v4l2";
import { authenticateNodeCredential, type AuthenticatedNode } from "./nodeCredentials";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/agentProtocol.ts is server-only operational code.");
}

export type AgentCameraInventoryItem = {
  stableId: string;
  devicePath: string;
  name?: string | null;
  formats?: CameraFormat[];
  available?: boolean;
};

export async function requireAgentAuth(prisma: PrismaClient, request: Request): Promise<AuthenticatedNode | Response> {
  const auth = await authenticateNodeCredential(prisma, request.headers.get("authorization"));
  if (!auth) {
    return Response.json({ error: "Unauthorized", reason: "Missing, invalid, or revoked node credential." }, { status: 401 });
  }
  return auth;
}

export async function recordHeartbeat(
  prisma: PrismaClient,
  nodeId: string,
  input: {
    hostname?: string | null;
    role?: string | null;
    operatingSystem?: string | null;
    architecture?: string | null;
    softwareVersion?: string | null;
  },
) {
  return prisma.plantLabNode.update({
    where: { id: nodeId },
    data: {
      status: "online",
      hostname: input.hostname ?? undefined,
      role: input.role ?? undefined,
      operatingSystem: input.operatingSystem ?? undefined,
      architecture: input.architecture ?? undefined,
      softwareVersion: input.softwareVersion ?? undefined,
      lastHeartbeatAt: new Date(),
    },
  });
}

export async function updateCameraInventory(prisma: PrismaClient, nodeId: string, cameras: AgentCameraInventoryItem[]) {
  const now = new Date();
  const seenStableIds = new Set<string>();
  const upserted = [];

  for (const camera of cameras) {
    const stableId = camera.stableId.trim();
    if (!stableId) {
      continue;
    }
    seenStableIds.add(stableId);
    upserted.push(
      await prisma.nodeCamera.upsert({
        where: { nodeId_stableId: { nodeId, stableId } },
        create: {
          nodeId,
          stableId,
          devicePath: camera.devicePath,
          name: camera.name ?? null,
          formatsJson: JSON.stringify(camera.formats ?? []),
          available: camera.available ?? true,
          lastSeenAt: now,
        },
        update: {
          devicePath: camera.devicePath,
          name: camera.name ?? null,
          formatsJson: JSON.stringify(camera.formats ?? []),
          available: camera.available ?? true,
          lastSeenAt: now,
        },
      }),
    );
  }

  await prisma.nodeCamera.updateMany({
    where: {
      nodeId,
      stableId: { notIn: Array.from(seenStableIds) },
    },
    data: { available: false },
  });

  return upserted;
}

export async function nextQueuedJob(prisma: PrismaClient, nodeId: string) {
  return prisma.agentCaptureJob.findFirst({
    where: { nodeId, status: "queued" },
    orderBy: { requestedAt: "asc" },
    include: {
      assignment: { include: { nodeCamera: true, captureSource: true } },
      captureSource: true,
    },
  });
}

export async function claimJob(prisma: PrismaClient, nodeId: string, jobId: string, captureId: string) {
  const updated = await prisma.agentCaptureJob.updateMany({
    where: { id: jobId, nodeId, status: "queued" },
    data: { status: "claimed", claimedAt: new Date(), captureId },
  });
  if (updated.count === 0) {
    return null;
  }
  return prisma.agentCaptureJob.findUnique({
    where: { id: jobId },
    include: { assignment: { include: { nodeCamera: true, captureSource: true } } },
  });
}

export async function failJob(prisma: PrismaClient, nodeId: string, jobId: string, errorMessage: string) {
  const updated = await prisma.agentCaptureJob.updateMany({
    where: { id: jobId, nodeId, status: { in: ["queued", "claimed"] } },
    data: {
      status: "failed",
      completedAt: new Date(),
      errorMessage: errorMessage.slice(0, 2000),
    },
  });
  return updated.count > 0;
}

export async function completeJob(prisma: PrismaClient, nodeId: string, jobId: string, captureId: string) {
  const sourceCapture = await prisma.sourceCapture.findUnique({ where: { captureId } });
  if (!sourceCapture) {
    return { ok: false as const, status: 404, error: "The uploaded capture has not been ingested yet." };
  }

  const updated = await prisma.agentCaptureJob.updateMany({
    where: { id: jobId, nodeId, status: "claimed", captureId },
    data: {
      status: "completed",
      completedAt: new Date(),
      sourceCaptureId: sourceCapture.id,
    },
  });
  if (updated.count === 0) {
    return { ok: false as const, status: 409, error: "The job was not in a claimable state for this node and captureId." };
  }

  return { ok: true as const, sourceCapture };
}

export function serializeJobForAgent(job: Awaited<ReturnType<typeof nextQueuedJob>>) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    captureSourceId: job.captureSourceId,
    assignmentId: job.assignmentId,
    camera: {
      stableId: job.assignment.nodeCamera.stableId,
      devicePath: job.assignment.nodeCamera.devicePath,
      name: job.assignment.nodeCamera.name,
    },
    settings: {
      width: job.assignment.width,
      height: job.assignment.height,
      inputFormat: job.assignment.inputFormat,
    },
  };
}
