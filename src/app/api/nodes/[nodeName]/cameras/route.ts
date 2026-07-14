import { NextResponse } from "next/server";
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
      formatsCount: camera.formats.length,
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

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
