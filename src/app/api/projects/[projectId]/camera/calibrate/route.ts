import { NextResponse } from "next/server";
import { getCameraSettings, capturePreviewFrame } from "@/lib/camera";
import { withCameraLock } from "@/lib/cameraLock";
import { lockCalibrationAutoModes, runAutoCalibration } from "@/lib/calibration";
import { badRequest, cameraErrorInfo, notFound, readJson } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { listCameraControls, listCameraFormats, setCameraControl } from "@/lib/v4l2";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

function driverFor(device: string) {
  return {
    listControls: () => listCameraControls(device),
    setControl: (control: string, value: string | number | boolean) =>
      setCameraControl(device, control, value),
    listFormats: () => listCameraFormats(device),
  };
}

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

  const device = process.env.CAMERA_DEVICE || project.cameraDevice;
  if (!device) {
    return badRequest("No camera selected for this project.");
  }

  const body = await readJson(request);
  const phase = typeof body?.phase === "string" ? body.phase : "run";
  const driver = driverFor(device);

  try {
    if (phase === "run") {
      const settings = getCameraSettings(project);

      const before = await capturePreviewFrame(settings);
      const result = await withCameraLock(device, () =>
        runAutoCalibration(driver, {
          currentFormat: settings.inputFormat,
          currentWidth: settings.width,
          currentHeight: settings.height,
        }),
      );
      const after = await capturePreviewFrame({
        ...settings,
        inputFormat: result.format,
        width: result.width,
        height: result.height,
      });

      return NextResponse.json({
        result,
        before: before.toString("base64"),
        after: after.toString("base64"),
      });
    }

    if (phase === "lock-auto-modes") {
      const lockWhiteBalance = body?.lockWhiteBalance === true;
      const lockExposure = body?.lockExposure === true;
      const controls = await withCameraLock(device, () =>
        lockCalibrationAutoModes(driver, { lockWhiteBalance, lockExposure }),
      );

      return NextResponse.json({ controls });
    }

    return badRequest(`Unknown calibration phase: ${phase}`);
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Auto Calibrate failed");
    return NextResponse.json({ error: message }, { status });
  }
}
