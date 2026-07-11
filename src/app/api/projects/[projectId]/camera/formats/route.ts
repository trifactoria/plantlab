import { NextResponse } from "next/server";
import { withCameraLock } from "@/lib/cameraLock";
import { badRequest, cameraErrorInfo, notFound } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { listCameraFormats } from "@/lib/v4l2";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return notFound("Project not found");
  }

  const device = process.env.CAMERA_DEVICE || project.cameraDevice;
  if (!device) {
    return badRequest("No camera selected for this project.");
  }

  if (process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1" && device === "/dev/video-test") {
    return NextResponse.json({
      formats: [
        {
          pixelFormat: "mjpg",
          description: "Motion-JPEG",
          resolutions: [
            { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
            { width: 1280, height: 720, frameRates: ["30.000 fps"] },
          ],
        },
        {
          pixelFormat: "yuyv",
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
