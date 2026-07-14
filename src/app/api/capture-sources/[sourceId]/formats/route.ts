import { NextResponse } from "next/server";
import { withCameraLock } from "@/lib/cameraLock";
import { cameraErrorInfo, notFound } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { testCameraMockModeEnabled } from "@/lib/testProjectSafety";
import { listCameraFormats } from "@/lib/v4l2";
import { parseNodeCameraFormats } from "@/lib/operations/nodeCameras";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ sourceId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { sourceId } = await context.params;
  const source = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: {
      assignments: {
        where: { active: true, nodeCamera: { available: true, enabled: true, retiredAt: null } },
        include: { nodeCamera: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });

  if (!source) {
    return notFound("Capture source not found");
  }

  const remoteAssignment = source.assignments[0];
  if (remoteAssignment) {
    return NextResponse.json({ formats: parseNodeCameraFormats(remoteAssignment.nodeCamera) });
  }

  const device = process.env.CAMERA_DEVICE || source.cameraDevice;

  if (testCameraMockModeEnabled() && device === "/dev/video-test") {
    return NextResponse.json({
      formats: [
        {
          pixelFormat: "mjpeg",
          description: "Motion-JPEG",
          resolutions: [
            { width: 3840, height: 2160, frameRates: ["15.000 fps"] },
            { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
            { width: 1280, height: 720, frameRates: ["30.000 fps"] },
          ],
        },
        {
          pixelFormat: "yuyv422",
          description: "YUYV 4:2:2",
          resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
        },
      ],
    });
  }

  try {
    const formats = await withCameraLock(device, () => listCameraFormats(device));
    return NextResponse.json({ formats });
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Could not read camera formats");
    return NextResponse.json({ error: message, formats: [] }, { status });
  }
}
