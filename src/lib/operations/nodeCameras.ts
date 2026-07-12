import path from "node:path";
import type { CaptureSource, NodeCamera, NodeCameraAssignment, PlantLabNode, PrismaClient } from "@prisma/client";
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
    return Array.isArray(parsed) ? (parsed as CameraFormat[]) : [];
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

  let createdCaptureSource = false;
  let captureSource: CaptureSource;
  if (input.captureSourceId) {
    captureSource = await prisma.captureSource.findUniqueOrThrow({ where: { id: input.captureSourceId } });
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
          inputFormat: input.inputFormat ?? "mjpeg",
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
          inputFormat: input.inputFormat ?? "mjpeg",
        },
      });

  return { node, camera, captureSource, assignment, createdCaptureSource, createdAssignment: !existing };
}

export function firstSupportedMode(camera: NodeCameraWithFormats): { width: number; height: number; inputFormat: string } {
  for (const format of camera.formats) {
    const resolution = format.resolutions[0];
    if (resolution) {
      return {
        width: resolution.width,
        height: resolution.height,
        inputFormat: format.pixelFormat || "mjpeg",
      };
    }
  }
  return { width: 1920, height: 1080, inputFormat: "mjpeg" };
}
