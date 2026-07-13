import path from "node:path";
import type { CaptureSource, NodeCamera, NodeCameraAssignment, PlantLabNode, PrismaClient } from "@prisma/client";
import { findCameraMode, normalizeCameraFormats, normalizeCameraInputFormat, preferredCameraMode } from "../cameraModes";
import { resolveCaptureSourcesDataDir } from "../paths.server";
import type { CameraFormat } from "../v4l2";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/nodeCameras.ts is server-only operational code.");
}

export type NodeCameraWithFormats = NodeCamera & { formats: CameraFormat[] };

export function parseNodeCameraFormats(camera: Pick<NodeCamera, "formatsJson">): CameraFormat[] {
  if (!camera.formatsJson) return [];
  try {
    const parsed = JSON.parse(camera.formatsJson);
    return Array.isArray(parsed) ? normalizeCameraFormats(parsed as CameraFormat[]) : [];
  } catch {
    return [];
  }
}

export async function listNodeCameras(prisma: PrismaClient, nodeName?: string | null) {
  const nodes = await prisma.plantLabNode.findMany({
    where: nodeName ? { name: nodeName } : undefined,
    include: { cameras: { orderBy: [{ available: "desc" }, { name: "asc" }] } },
    orderBy: { name: "asc" },
  });
  return nodes.map((node) => ({
    ...node,
    cameras: node.cameras.map((camera) => ({ ...camera, formats: parseNodeCameraFormats(camera) })),
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
