import { NextResponse } from "next/server";
import { capturePreviewFrame, getCameraSettings } from "@/lib/camera";
import { withCameraLock } from "@/lib/cameraLock";
import { badRequest, cameraErrorInfo, notFound, readJson } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { compareResolutions, supportedCandidateResolutions } from "@/lib/resolutionCompare";
import { testCameraMockModeEnabled, testProjectCameraError } from "@/lib/testProjectSafety";
import { listCameraFormats } from "@/lib/v4l2";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function POST(request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { cameraProfile: true },
  });

  if (!project) {
    return notFound("Project not found");
  }

  if (project.isTestProject && !testCameraMockModeEnabled()) {
    const blocked = testProjectCameraError();
    return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  }

  const device = process.env.CAMERA_DEVICE || project.cameraDevice;
  if (!device) {
    return badRequest("No camera selected for this project.");
  }

  const body = await readJson(request);
  const pixelFormat =
    typeof body?.pixelFormat === "string" ? body.pixelFormat : project.cameraProfile?.inputFormat ?? "mjpeg";

  try {
    const formats = await withCameraLock(device, () => listCameraFormats(device));
    const candidates = supportedCandidateResolutions(formats, pixelFormat);

    if (candidates.length === 0) {
      return badRequest(
        `No comparison resolutions (1920x1080, 2560x1440, 3840x2160) are supported for ${pixelFormat} on this camera.`,
      );
    }

    const settings = getCameraSettings(project);
    const results = await compareResolutions(candidates, (width, height) =>
      capturePreviewFrame({ ...settings, inputFormat: pixelFormat, width, height }),
    );

    return NextResponse.json({ results });
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Resolution comparison failed");
    return NextResponse.json({ error: message }, { status });
  }
}
