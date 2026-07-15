import path from "node:path";
import type { CaptureSource, NodeCamera, NodeCameraAssignment, PlantLabNode, Prisma, PrismaClient } from "@prisma/client";
import { usbPathSuffix } from "../cameraIdentity";
import { findCameraMode, normalizeCameraFormats, normalizeCameraInputFormat, preferredCameraMode } from "../cameraModes";
import { resolveCaptureSourcesDataDir } from "../paths.server";
import type { CameraFormat } from "../v4l2";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/nodeCameras.ts is server-only operational code.");
}

export type NodeCameraAlternateDevice = { device: string; supportsCapture?: boolean; reason?: string | null };
export type NodeCameraWithFormats = NodeCamera & { formats: CameraFormat[]; alternateDevices?: NodeCameraAlternateDevice[] };

export function parseNodeCameraFormats(camera: Pick<NodeCamera, "formatsJson">): CameraFormat[] {
  if (!camera.formatsJson) return [];
  try {
    const parsed = JSON.parse(camera.formatsJson);
    return Array.isArray(parsed) ? normalizeCameraFormats(parsed as CameraFormat[]) : [];
  } catch {
    return [];
  }
}

export function parseNodeCameraAlternateDevices(camera: Pick<NodeCamera, "alternateDevicesJson">): NodeCameraAlternateDevice[] {
  if (!camera.alternateDevicesJson) return [];
  try {
    const parsed = JSON.parse(camera.alternateDevicesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): NodeCameraAlternateDevice[] => {
      if (typeof item === "string") return [{ device: item }];
      if (item && typeof item === "object" && typeof item.device === "string") {
        return [
          {
            device: item.device,
            supportsCapture: typeof item.supportsCapture === "boolean" ? item.supportsCapture : undefined,
            reason: typeof item.reason === "string" ? item.reason : null,
          },
        ];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function nodeCameraDisplayName(camera: Pick<NodeCamera, "name" | "usbPort" | "physicalPath" | "usbPath">): string {
  const name = camera.name ?? "Unknown camera";
  const suffix = camera.usbPort ?? usbPathSuffix(camera.physicalPath ?? camera.usbPath);
  if (!suffix || name.includes(`(${suffix})`) || name.includes(`USB path ${suffix}`)) return name;
  return `${name} - USB path ${suffix}`;
}

export async function listNodeCameras(prisma: PrismaClient, nodeName?: string | null) {
  const nodes = await prisma.plantLabNode.findMany({
    where: nodeName ? { name: nodeName } : undefined,
    include: {
      cameras: {
        include: {
          endpoints: { orderBy: [{ available: "desc" }, { observedAt: "desc" }], take: 10 },
          // The active capture assignment (resolution/input format/name), its
          // capture source (where rotation actually lives - never on the
          // assignment), and the most recent capture job (recent success/
          // error) drive the camera-management "current assignment", rotation/
          // config editing, and recent-capture surfaces.
          assignments: {
            where: { active: true },
            include: { captureSource: true, jobs: { orderBy: { requestedAt: "desc" }, take: 1 } },
            orderBy: { updatedAt: "desc" },
            take: 1,
          },
        },
        orderBy: [{ retiredAt: "asc" }, { available: "desc" }, { name: "asc" }],
      },
    },
    orderBy: { name: "asc" },
  });
  return nodes.map((node) => ({
    ...node,
    cameras: node.cameras.map((camera) => ({
      ...camera,
      formats: parseNodeCameraFormats(camera),
      alternateDevices: parseNodeCameraAlternateDevices(camera),
    })),
  }));
}

export async function attachNodeCamera(
  prisma: PrismaClient,
  input: {
    nodeName: string;
    stableId: string;
    captureSourceId?: string | null;
    newCaptureSourceName?: string | null;
    width: number;
    height: number;
    inputFormat?: string;
  },
): Promise<{
  node: PlantLabNode;
  camera: NodeCamera;
  captureSource: CaptureSource;
  assignment: NodeCameraAssignment;
  createdCaptureSource: boolean;
  createdAssignment: boolean;
}> {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: input.nodeName } });
  const camera = await prisma.nodeCamera.findUniqueOrThrow({
    where: { nodeId_stableId: { nodeId: node.id, stableId: input.stableId } },
  });
  const cameraWithFormats: NodeCameraWithFormats = { ...camera, formats: parseNodeCameraFormats(camera) };
  const inputFormat = normalizeCameraInputFormat(input.inputFormat);
  if (cameraWithFormats.formats.length > 0 && !cameraSupportsMode(cameraWithFormats, { inputFormat, width: input.width, height: input.height })) {
    throw new Error(`Camera does not advertise ${inputFormat.toUpperCase()} ${input.width}x${input.height}. Refresh inventory and choose a listed mode.`);
  }

  let createdCaptureSource = false;
  let captureSource: CaptureSource;
  if (input.captureSourceId) {
    // Part 7 reconciliation: an existing source's cameraDevice/cameraName
    // are display-only fields (actual captures resolve the device via
    // NodeCameraAssignment -> NodeCamera.devicePath at job-creation time,
    // kept fresh by every heartbeat's inventory upsert - see
    // agentProtocol.ts serializeJobForAgent()) - but they must still
    // reflect the current verified primary device, not a stale path from
    // whenever this source was first created (e.g. bokchoy's video1 ->
    // video0 reconciliation).
    captureSource = await prisma.captureSource.update({
      where: { id: input.captureSourceId },
      data: { cameraDevice: camera.devicePath, cameraName: camera.name, cameraStableId: camera.stableId },
    });
  } else {
    const name = (input.newCaptureSourceName ?? `${node.name} ${camera.name ?? "Camera"}`).trim();
    captureSource = await prisma.captureSource.create({
      data: {
        name,
        cameraDevice: camera.devicePath,
        cameraName: camera.name,
        cameraStableId: camera.stableId,
        width: input.width,
        height: input.height,
        captureDirectory: path.join(resolveCaptureSourcesDataDir(), name.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase()),
        photoIntervalMinutes: 60,
        active: true,
      },
    });
    createdCaptureSource = true;
  }

  await prisma.nodeCamera.update({
    where: { id: camera.id },
    data: { captureSourceId: captureSource.id },
  });

  const existing = await prisma.nodeCameraAssignment.findUnique({
    where: {
      nodeId_nodeCameraId_captureSourceId: {
        nodeId: node.id,
        nodeCameraId: camera.id,
        captureSourceId: captureSource.id,
      },
    },
  });

  const assignment = existing
    ? await prisma.nodeCameraAssignment.update({
        where: { id: existing.id },
        data: {
          name: captureSource.name,
          width: input.width,
          height: input.height,
          inputFormat,
          active: true,
        },
      })
    : await prisma.nodeCameraAssignment.create({
        data: {
          nodeId: node.id,
          nodeCameraId: camera.id,
          captureSourceId: captureSource.id,
          name: captureSource.name,
          width: input.width,
          height: input.height,
          inputFormat,
        },
      });

  return { node, camera, captureSource, assignment, createdCaptureSource, createdAssignment: !existing };
}

/**
 * The default resolution/format offered when a caller doesn't explicitly
 * choose one (see camera.ts's runCameraAttachFlow) - prefers MJPEG among
 * the camera's actually-reported formats (Part 6). The fallback below is
 * only reached when a camera has genuinely reported no formats at all
 * (e.g. discovery hasn't completed yet); it is deliberately a
 * conservative, commonly-supported resolution (Part 5/6: "fall back to a
 * conservative resolution such as 640x480") rather than an unverified
 * 1920x1080 guess - the real bokchoy failure: an unverified device with
 * empty formats fell back to 1920x1080 and the capture failed outright.
 */
export function firstSupportedMode(camera: NodeCameraWithFormats): { width: number; height: number; inputFormat: string } {
  const preferred = preferredCameraMode(camera.formats);
  if (preferred) {
    return { width: preferred.width, height: preferred.height, inputFormat: preferred.inputFormat };
  }
  return { width: 640, height: 480, inputFormat: "mjpeg" };
}

export function cameraSupportsMode(camera: NodeCameraWithFormats, mode: { inputFormat: string; width: number; height: number }) {
  return Boolean(findCameraMode(camera.formats, mode.inputFormat, mode.width, mode.height));
}

export async function renameNodeCamera(prisma: PrismaClient, input: { nodeName: string; cameraId: string; name: string; requestedBy?: string | null }) {
  const camera = await requireNodeCamera(prisma, input.nodeName, input.cameraId);
  const updated = await prisma.nodeCamera.update({ where: { id: camera.id }, data: { name: input.name.trim() } });
  await recordCameraAudit(prisma, camera.nodeId, camera.id, "rename", "applied", { name: camera.name }, { name: updated.name }, null, input.requestedBy);
  return updated;
}

export async function setNodeCameraEnabled(
  prisma: PrismaClient,
  input: { nodeName: string; cameraId: string; enabled: boolean; requestedBy?: string | null },
) {
  const camera = await requireNodeCamera(prisma, input.nodeName, input.cameraId);
  const updated = await prisma.nodeCamera.update({ where: { id: camera.id }, data: { enabled: input.enabled } });
  await recordCameraAudit(prisma, camera.nodeId, camera.id, input.enabled ? "enable" : "disable", "applied", { enabled: camera.enabled }, { enabled: updated.enabled }, null, input.requestedBy);
  return updated;
}

export async function retireNodeCamera(prisma: PrismaClient, input: { nodeName: string; cameraId: string; requestedBy?: string | null }) {
  const camera = await requireNodeCamera(prisma, input.nodeName, input.cameraId);
  const now = new Date();
  const updated = await prisma.nodeCamera.update({ where: { id: camera.id }, data: { enabled: false, retiredAt: now } });
  await prisma.nodeCameraAssignment.updateMany({ where: { nodeCameraId: camera.id }, data: { active: false } });
  await recordCameraAudit(prisma, camera.nodeId, camera.id, "retire", "applied", { retiredAt: camera.retiredAt, enabled: camera.enabled }, { retiredAt: now, enabled: false }, null, input.requestedBy);
  return updated;
}

export async function restoreNodeCamera(prisma: PrismaClient, input: { nodeName: string; cameraId: string; requestedBy?: string | null }) {
  const camera = await requireNodeCamera(prisma, input.nodeName, input.cameraId);
  const updated = await prisma.nodeCamera.update({ where: { id: camera.id }, data: { enabled: true, retiredAt: null } });
  await recordCameraAudit(prisma, camera.nodeId, camera.id, "restore", "applied", { retiredAt: camera.retiredAt, enabled: camera.enabled }, { retiredAt: null, enabled: true }, null, input.requestedBy);
  return updated;
}

export async function updateCameraAssignmentConfig(
  prisma: PrismaClient,
  input: { nodeName: string; assignmentId: string; width?: number; height?: number; inputFormat?: string; name?: string; active?: boolean; requestedBy?: string | null },
) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: input.nodeName } });
  const assignment = await prisma.nodeCameraAssignment.findFirstOrThrow({ where: { id: input.assignmentId, nodeId: node.id } });
  const data: Prisma.NodeCameraAssignmentUpdateInput = {};
  if (input.width !== undefined) data.width = input.width;
  if (input.height !== undefined) data.height = input.height;
  if (input.inputFormat !== undefined) data.inputFormat = normalizeCameraInputFormat(input.inputFormat);
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.active !== undefined) data.active = input.active;
  const updated = await prisma.nodeCameraAssignment.update({ where: { id: assignment.id }, data });
  await recordCameraAudit(prisma, node.id, assignment.nodeCameraId, "update-assignment", "applied", assignment, updated, null, input.requestedBy);
  return updated;
}

/**
 * Queues a single AgentCaptureJob for a camera's active assignment - the
 * same durable coordinator-to-edge capture queue the scheduler uses (see
 * nextServableJob/claimJob/completeJob in agentProtocol.ts). Structured
 * action, never a shelled command: the edge polls, captures with ffmpeg,
 * and uploads. The UI polls the camera list to watch the job's status.
 */
export async function queueCameraTestCapture(prisma: PrismaClient, input: { nodeName: string; assignmentId: string }) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: input.nodeName } });
  const assignment = await prisma.nodeCameraAssignment.findFirstOrThrow({ where: { id: input.assignmentId, nodeId: node.id } });
  const active = await prisma.agentCaptureJob.findFirst({ where: { nodeId: node.id, assignmentId: assignment.id, status: { in: ["queued", "claimed"] } } });
  if (active) return { jobId: active.id, reused: true };
  const job = await prisma.agentCaptureJob.create({
    data: { nodeId: node.id, assignmentId: assignment.id, captureSourceId: assignment.captureSourceId },
  });
  return { jobId: job.id, reused: false };
}

export async function listCameraReattachCandidates(prisma: PrismaClient, input: { nodeName: string; cameraId: string }) {
  const camera = await requireNodeCamera(prisma, input.nodeName, input.cameraId);
  const endpoints = await prisma.nodeCameraEndpoint.findMany({
    where: { nodeId: camera.nodeId, available: true },
    orderBy: [{ observedAt: "desc" }, { devicePath: "asc" }],
  });
  return endpoints.map((endpoint) => {
    const evidence = safeJson(endpoint.evidenceJson);
    const score = endpoint.nodeCameraId === camera.id ? 100 : endpoint.stableId === camera.stableId ? 95 : endpoint.stableId === camera.legacyStableId ? 80 : endpoint.serial && endpoint.serial === camera.serial && endpoint.vendorId === camera.vendorId && endpoint.productId === camera.productId ? 70 : 30;
    const reasons = [];
    if (endpoint.nodeCameraId === camera.id) reasons.push("already-linked-logical-camera");
    if (endpoint.stableId === camera.stableId) reasons.push("stable-id-match");
    if (endpoint.stableId === camera.legacyStableId) reasons.push("legacy-stable-id-match");
    if (endpoint.serial && endpoint.serial === camera.serial && endpoint.vendorId === camera.vendorId && endpoint.productId === camera.productId) reasons.push("vendor-product-serial-match");
    if (endpoint.physicalPath && endpoint.physicalPath === camera.physicalPath) reasons.push("physical-path-match");
    return {
      endpoint,
      confidence: score >= 90 ? "high" : score >= 70 ? "medium" : "low",
      score,
      reasons,
      evidence,
    };
  });
}

export async function reattachNodeCamera(
  prisma: PrismaClient,
  input: { nodeName: string; cameraId: string; endpointId: string; force?: boolean; requestedBy?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const camera = await requireNodeCamera(tx, input.nodeName, input.cameraId);
    const endpoint = await tx.nodeCameraEndpoint.findFirstOrThrow({ where: { id: input.endpointId, nodeId: camera.nodeId, available: true } });
    const activeOwner = endpoint.nodeCameraId
      ? await tx.nodeCamera.findFirst({ where: { id: endpoint.nodeCameraId, retiredAt: null, enabled: true }, include: { assignments: { where: { active: true } } } })
      : null;
    if (activeOwner && activeOwner.id !== camera.id && activeOwner.assignments.length > 0 && !input.force) {
      await recordCameraAudit(tx, camera.nodeId, camera.id, "reattach", "rejected", camera, endpoint, { reason: "endpoint-assigned", ownerCameraId: activeOwner.id }, input.requestedBy);
      throw new Error("Endpoint is already assigned to another active logical camera; pass an explicit force option after operator confirmation.");
    }
    if (activeOwner && activeOwner.id !== camera.id && activeOwner.assignments.length === 0) {
      await tx.nodeCamera.update({
        where: { id: activeOwner.id },
        data: {
          stableId: `retired-duplicate:${activeOwner.id}:${activeOwner.stableId}`,
          available: false,
          enabled: false,
          retiredAt: new Date(),
        },
      });
      await recordCameraAudit(
        tx,
        camera.nodeId,
        activeOwner.id,
        "retire-duplicate-before-reattach",
        "applied",
        { stableId: activeOwner.stableId, endpointId: endpoint.id },
        { replacementCameraId: camera.id },
        safeJson(endpoint.evidenceJson),
        input.requestedBy,
      );
    }

    const previous = { stableId: camera.stableId, devicePath: camera.devicePath, available: camera.available, endpointId: endpoint.id };
    const updated = await tx.nodeCamera.update({
      where: { id: camera.id },
      data: {
        stableId: endpoint.stableId,
        devicePath: endpoint.devicePath,
        name: endpoint.name ?? camera.name,
        vendorId: endpoint.vendorId,
        productId: endpoint.productId,
        serial: endpoint.serial,
        physicalPath: endpoint.physicalPath,
        usbPath: endpoint.usbPath,
        usbPort: endpoint.usbPort,
        alternateDevicesJson: endpoint.alternateDevicesJson,
        formatsJson: endpoint.formatsJson,
        identityEvidenceJson: endpoint.evidenceJson,
        available: true,
        enabled: true,
        retiredAt: null,
        lastSeenAt: endpoint.observedAt,
      },
    });
    await tx.nodeCameraEndpoint.update({ where: { id: endpoint.id }, data: { nodeCameraId: camera.id } });
    await recordCameraAudit(tx, camera.nodeId, camera.id, "reattach", "applied", previous, { stableId: updated.stableId, devicePath: updated.devicePath, endpointId: endpoint.id }, safeJson(endpoint.evidenceJson), input.requestedBy);
    return { camera: updated, endpoint };
  });
}

async function requireNodeCamera(prisma: PrismaClient | Prisma.TransactionClient, nodeName: string, cameraId: string) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: nodeName } });
  return prisma.nodeCamera.findFirstOrThrow({ where: { id: cameraId, nodeId: node.id } });
}

async function recordCameraAudit(
  prisma: PrismaClient | Prisma.TransactionClient,
  nodeId: string,
  nodeCameraId: string | null,
  operation: string,
  status: string,
  previousState: unknown,
  nextState: unknown,
  evidence: unknown,
  requestedBy?: string | null,
) {
  await prisma.nodeCameraRepairAudit.create({
    data: {
      nodeId,
      nodeCameraId,
      operation,
      status,
      requestedBy: requestedBy ?? null,
      previousStateJson: previousState === null || previousState === undefined ? null : JSON.stringify(previousState),
      nextStateJson: nextState === null || nextState === undefined ? null : JSON.stringify(nextState),
      evidenceJson: evidence === null || evidence === undefined ? null : JSON.stringify(evidence),
    },
  });
}

function safeJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
