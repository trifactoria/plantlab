import { NextResponse } from "next/server";
import { capturePreviewFrame, getCameraSettings } from "@/lib/camera";
import { verifyCapturedDimensions } from "@/lib/captureVerify";
import { badRequest, cameraErrorInfo, notFound, readJson } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { testCameraMockModeEnabled, testProjectCameraError } from "@/lib/testProjectSafety";

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
  const width = typeof body?.width === "number" ? body.width : project.cameraProfile?.width;
  const height = typeof body?.height === "number" ? body.height : project.cameraProfile?.height;
  const inputFormat = typeof body?.inputFormat === "string" ? body.inputFormat : undefined;

  if (!width || !height) {
    return badRequest("A width and height are required to verify a capture.");
  }

  try {
    const settings = getCameraSettings(project);
    const requested = { width, height };
    const buffer = await capturePreviewFrame({
      ...settings,
      width,
      height,
      inputFormat: inputFormat ?? settings.inputFormat,
    });
    const verification = await verifyCapturedDimensions(buffer, requested);

    return NextResponse.json({
      ...verification,
      imageBase64: buffer.toString("base64"),
    });
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Full-resolution verification capture failed");
    return NextResponse.json({ error: message }, { status });
  }
}
