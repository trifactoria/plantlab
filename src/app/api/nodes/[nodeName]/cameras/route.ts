import { NextResponse } from "next/server";
import { computeCameraStatus } from "@/lib/hardware/cameraStatus";
import { listNodeCameras, nodeCameraDisplayName } from "@/lib/operations/nodeCameras";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const nodes = await listNodeCameras(prisma, nodeName);
  const node = nodes[0];
  if (!node) {
    return NextResponse.json({ error: `No registered node named "${nodeName}".` }, { status: 404 });
  }
  return NextResponse.json({
    node: { id: node.id, name: node.name },
    cameras: node.cameras.map((camera) => ({
      id: camera.id,
      stableId: camera.stableId,
      legacyStableId: camera.legacyStableId,
      name: nodeCameraDisplayName(camera),
      displayName: camera.displayName,
      reportedName: camera.reportedName,
      devicePath: camera.devicePath,
      available: camera.available,
      enabled: camera.enabled,
      retiredAt: camera.retiredAt?.toISOString() ?? null,
      lastSeenAt: camera.lastSeenAt.toISOString(),
      vendorId: camera.vendorId,
      productId: camera.productId,
      serial: camera.serial,
      physicalPath: camera.physicalPath,
      usbPath: camera.usbPath,
      usbPort: camera.usbPort,
      identityEvidence: parseJson(camera.identityEvidenceJson),
      captureSourceId: camera.captureSourceId,
      formats: camera.formats,
      formatsCount: camera.formats.length,
      ...cameraStatusPayload(camera),
      // Active capture assignment (resolution/input format/name) + its
      // capture source. Rotation lives on the capture source, never on the
      // assignment, so it is surfaced here read-through with the source id
      // the rotation edit must target.
      assignment:
        "assignments" in camera && Array.isArray(camera.assignments) && camera.assignments[0]
          ? {
              id: camera.assignments[0].id,
              name: camera.assignments[0].name,
              width: camera.assignments[0].width,
              height: camera.assignments[0].height,
              inputFormat: camera.assignments[0].inputFormat,
              active: camera.assignments[0].active,
              captureSource: camera.assignments[0].captureSource
                ? {
                    id: camera.assignments[0].captureSource.id,
                    name: camera.assignments[0].captureSource.name,
                    rotation: camera.assignments[0].captureSource.rotation,
                    flipHorizontal: camera.assignments[0].captureSource.flipHorizontal,
                    flipVertical: camera.assignments[0].captureSource.flipVertical,
                  }
                : null,
              recentJob: camera.assignments[0].jobs[0]
                ? {
                    id: camera.assignments[0].jobs[0].id,
                    status: camera.assignments[0].jobs[0].status,
                    requestedAt: camera.assignments[0].jobs[0].requestedAt.toISOString(),
                    completedAt: camera.assignments[0].jobs[0].completedAt?.toISOString() ?? null,
                    errorMessage: camera.assignments[0].jobs[0].errorMessage,
                  }
                : null,
            }
          : null,
      endpoints: "endpoints" in camera && Array.isArray(camera.endpoints)
        ? camera.endpoints.map((endpoint) => ({
            id: endpoint.id,
            stableId: endpoint.stableId,
            devicePath: endpoint.devicePath,
            available: endpoint.available,
            observedAt: endpoint.observedAt.toISOString(),
            unavailableAt: endpoint.unavailableAt?.toISOString() ?? null,
            confidence: endpoint.confidence,
            evidence: parseJson(endpoint.evidenceJson),
          }))
        : [],
    })),
  });
}

function cameraStatusPayload(camera: Awaited<ReturnType<typeof listNodeCameras>>[number]["cameras"][number]) {
  const assignment = "assignments" in camera && Array.isArray(camera.assignments) ? camera.assignments[0] : null;
  const endpointAvailable = "endpoints" in camera && Array.isArray(camera.endpoints) ? camera.endpoints.some((endpoint) => endpoint.available) : camera.available;
  const status = computeCameraStatus({
    nodeOnline: true,
    cameraAvailable: camera.available,
    cameraEnabled: camera.enabled,
    cameraRetired: Boolean(camera.retiredAt),
    assignmentActive: assignment?.active ?? true,
    captureSourceActive: assignment?.captureSource?.active ?? true,
    currentEndpointAvailable: endpointAvailable,
  });
  return { status: status.status, statusReason: status.reason, usableForCapture: status.usableForCapture };
}

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
