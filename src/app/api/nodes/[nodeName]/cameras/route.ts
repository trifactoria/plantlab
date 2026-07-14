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
      stableId: camera.stableId,
      name: nodeCameraDisplayName(camera),
      devicePath: camera.devicePath,
      available: camera.available,
      lastSeenAt: camera.lastSeenAt.toISOString(),
      vendorId: camera.vendorId,
      productId: camera.productId,
      serial: camera.serial,
      captureSourceId: camera.captureSourceId,
      formatsCount: camera.formats.length,
    })),
  });
}
