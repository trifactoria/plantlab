import type { PrismaClient } from "@prisma/client";
import { normalizeCameraFormats, type CameraFormat } from "../cameraModes";
import { authenticateNodeCredential, type AuthenticatedNode } from "./nodeCredentials";
import { serializeCapabilities } from "./capabilities";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/agentProtocol.ts is server-only operational code.");
}

export type AgentCameraInventoryItem = {
  stableId: string;
  legacyStableId?: string | null;
  devicePath: string;
  name?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  serial?: string | null;
  physicalPath?: string | null;
  usbPath?: string | null;
  usbPort?: string | null;
  alternateDevices?: Array<{ device: string; supportsCapture?: boolean; reason?: string | null }> | string[];
  formats?: CameraFormat[];
  formatsStatus?: "ok" | "unavailable" | "error";
  formatsError?: string | null;
  available?: boolean;
};

function countModes(formats: CameraFormat[]) {
  return formats.reduce((sum, format) => sum + format.resolutions.length, 0);
}

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
    /** "node" or "python-edge" - which agent implementation sent this heartbeat. See edge-agent/ and capabilities.ts. */
    runtime?: string | null;
    /** The agent protocol version this agent implements - see docs/AGENT_PROTOCOL.md. */
    protocolVersion?: string | null;
    /** What this node can actually do right now - a live heartbeat always wins over whatever registerOrRotateNode() seeded at enrollment time. */
    capabilities?: string[] | null;
  },
) {
  // Unconditionally overwrites `status` - this is also how a
  // "repair-required" flag (see nodeCredentials.ts markNodeStatus()) gets
  // cleared: a real heartbeat is direct evidence the agent is running
  // correctly again, so it always wins over a stale repair flag. The
  // effective display status (pending/active/repair-required/revoked/
  // offline) is computed from this field + lastHeartbeatAt by
  // computeNodeStatus(), never read verbatim.
  return prisma.plantLabNode.update({
    where: { id: nodeId },
    data: {
      status: "online",
      hostname: input.hostname ?? undefined,
      role: input.role ?? undefined,
      operatingSystem: input.operatingSystem ?? undefined,
      architecture: input.architecture ?? undefined,
      softwareVersion: input.softwareVersion ?? undefined,
      runtime: input.runtime ?? undefined,
      protocolVersion: input.protocolVersion ?? undefined,
      capabilitiesJson: input.capabilities ? serializeCapabilities(input.capabilities) : undefined,
      lastHeartbeatAt: new Date(),
    },
  });
}

export async function updateCameraInventory(prisma: PrismaClient, nodeId: string, cameras: AgentCameraInventoryItem[]) {
  const now = new Date();
  const seenStableIds = new Set<string>();
  const upserted = [];
  const reportsByLegacyStableId = new Map<string, AgentCameraInventoryItem[]>();

  for (const camera of cameras) {
    const legacy = legacyStableIdForReport(camera);
    if (!legacy) continue;
    reportsByLegacyStableId.set(legacy, [...(reportsByLegacyStableId.get(legacy) ?? []), camera]);
  }
  const migratedLegacyCameraIds = new Set<string>();

  for (const camera of cameras) {
    const stableId = camera.stableId.trim();
    if (!stableId) {
      continue;
    }
    const nextFormats = normalizeCameraFormats(camera.formats ?? []);
    const shouldUseEmptyFormats =
      nextFormats.length > 0 || camera.formatsStatus === "ok" || camera.formatsStatus === "unavailable";
    const existing = await prisma.nodeCamera.findUnique({ where: { nodeId_stableId: { nodeId, stableId } } });
    const legacyStableId = legacyStableIdForReport(camera);
    const migratedExisting =
      existing ??
      (legacyStableId && legacyStableId !== stableId
        ? await findMigratableLegacyCamera(prisma, nodeId, legacyStableId, stableId, camera.devicePath, reportsByLegacyStableId, migratedLegacyCameraIds)
        : null);
    const existingFormats = migratedExisting ? normalizeCameraFormats(parseStoredFormats(migratedExisting.formatsJson)) : [];
    const formatsForWrite = shouldUseEmptyFormats || existingFormats.length === 0 ? nextFormats : existingFormats;
    const data = {
      stableId,
      legacyStableId,
      devicePath: camera.devicePath,
      name: camera.name ?? null,
      vendorId: camera.vendorId ?? null,
      productId: camera.productId ?? null,
      serial: camera.serial ?? null,
      physicalPath: camera.physicalPath ?? null,
      usbPath: camera.usbPath ?? camera.physicalPath ?? null,
      usbPort: camera.usbPort ?? null,
      alternateDevicesJson: JSON.stringify(camera.alternateDevices ?? []),
      formatsJson: JSON.stringify(formatsForWrite),
      available: camera.available ?? true,
      lastSeenAt: now,
    };
    seenStableIds.add(stableId);
    if (migratedExisting) {
      migratedLegacyCameraIds.add(migratedExisting.id);
      upserted.push(
        await prisma.nodeCamera.update({
          where: { id: migratedExisting.id },
          data,
        }),
      );
    } else {
      upserted.push(
        await prisma.nodeCamera.upsert({
          where: { nodeId_stableId: { nodeId, stableId } },
          create: {
            nodeId,
            ...data,
          },
          update: data,
        }),
      );
    }
  }

  await Promise.all([
    prisma.nodeCamera.updateMany({
      where: {
        nodeId,
        stableId: { notIn: Array.from(seenStableIds) },
      },
      data: { available: false },
    }),
    prisma.plantLabNode.update({
      where: { id: nodeId },
      data: {
        lastInventoryAt: now,
        inventoryRefreshRequestedAt: null,
      },
    }),
  ]);

  return upserted;
}

function legacyStableIdForReport(camera: Pick<AgentCameraInventoryItem, "legacyStableId" | "vendorId" | "productId" | "serial">): string | null {
  if (camera.legacyStableId) return camera.legacyStableId;
  if (camera.vendorId && camera.productId) {
    return `usb:${camera.vendorId}:${camera.productId}:${camera.serial || "noserial"}`;
  }
  return null;
}

async function findMigratableLegacyCamera(
  prisma: PrismaClient,
  nodeId: string,
  legacyStableId: string,
  nextStableId: string,
  nextDevicePath: string,
  reportsByLegacyStableId: Map<string, AgentCameraInventoryItem[]>,
  migratedLegacyCameraIds: Set<string>,
) {
  const legacy = await prisma.nodeCamera.findUnique({ where: { nodeId_stableId: { nodeId, stableId: legacyStableId } } });
  if (!legacy || migratedLegacyCameraIds.has(legacy.id)) return null;

  const reports = reportsByLegacyStableId.get(legacyStableId) ?? [];
  if (reports.length === 1 && reports[0].stableId === nextStableId) {
    return legacy;
  }

  const matchingDeviceReports = reports.filter((report) => report.devicePath === legacy.devicePath);
  if (matchingDeviceReports.length === 1 && matchingDeviceReports[0].stableId === nextStableId && nextDevicePath === legacy.devicePath) {
    return legacy;
  }

  return null;
}

function parseStoredFormats(formatsJson: string | null): CameraFormat[] {
  if (!formatsJson) return [];
  try {
    const parsed = JSON.parse(formatsJson);
    return Array.isArray(parsed) ? (parsed as CameraFormat[]) : [];
  } catch {
    return [];
  }
}

export function inventoryDiagnosticsForCamera(camera: { formatsJson: string | null; lastSeenAt: Date | null }) {
  const formats = normalizeCameraFormats(parseStoredFormats(camera.formatsJson));
  return {
    lastInventoryReceivedAt: camera.lastSeenAt,
    formatsReceivedCount: formats.length,
    modesReceivedCount: countModes(formats),
    formatsJsonEmpty: formats.length === 0,
  };
}

export async function requestCameraInventoryRefresh(prisma: PrismaClient, nodeName: string) {
  return prisma.plantLabNode.update({
    where: { name: nodeName },
    data: { inventoryRefreshRequestedAt: new Date() },
  });
}

export async function getInventoryRefreshRequest(prisma: PrismaClient, nodeId: string) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({
    where: { id: nodeId },
    select: { inventoryRefreshRequestedAt: true },
  });
  return node.inventoryRefreshRequestedAt;
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
