import { NextResponse } from "next/server";
import { withCameraLock } from "@/lib/cameraLock";
import { badRequest, cameraErrorInfo, notFound, readJson, requiredString } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { listCameraControls, setCameraControl } from "@/lib/v4l2";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

async function selectedDevice(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return { error: notFound("Project not found") };
  }

  const device = process.env.CAMERA_DEVICE || project.cameraDevice;

  if (!device) {
    return { error: badRequest("No camera selected for this project.") };
  }

  return { device };
}

function mockControls() {
  return [
    {
      id: "focus_automatic_continuous",
      name: "Focus Automatic Continuous",
      type: "bool",
      value: true,
      defaultValue: true,
      readOnly: false,
      inactive: false,
    },
    {
      id: "focus_absolute",
      name: "Focus Absolute",
      type: "int",
      value: 20,
      minimum: 0,
      maximum: 255,
      step: 5,
      defaultValue: 0,
      readOnly: false,
      // Inactive while continuous autofocus (above) is enabled.
      inactive: true,
    },
    {
      id: "white_balance_automatic",
      name: "White Balance Automatic",
      type: "bool",
      value: true,
      defaultValue: true,
      readOnly: false,
      inactive: false,
    },
    {
      id: "white_balance_temperature",
      name: "White Balance Temperature",
      type: "int",
      value: 4600,
      minimum: 2800,
      maximum: 6500,
      step: 10,
      defaultValue: 4600,
      readOnly: false,
      inactive: true,
    },
    {
      id: "exposure_auto",
      name: "Exposure Auto",
      type: "menu",
      value: 3,
      defaultValue: 3,
      readOnly: false,
      inactive: false,
      options: [
        { value: 1, label: "Manual Mode" },
        { value: 3, label: "Aperture Priority Mode" },
      ],
    },
    {
      id: "brightness",
      name: "Brightness",
      type: "int",
      value: 128,
      minimum: 0,
      maximum: 255,
      step: 1,
      defaultValue: 128,
      readOnly: false,
      inactive: false,
    },
  ];
}

export async function GET(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { projectId } = await context.params;
  const result = await selectedDevice(projectId);

  if (result.error) {
    return result.error;
  }

  if (process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1" && result.device === "/dev/video-test") {
    return NextResponse.json({ controls: mockControls() });
  }

  try {
    const controls = await withCameraLock(result.device, () => listCameraControls(result.device));
    return NextResponse.json({ controls });
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Could not read camera controls");
    return NextResponse.json({ error: message, controls: [] }, { status });
  }
}

export async function PATCH(request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { projectId } = await context.params;
  const result = await selectedDevice(projectId);

  if (result.error) {
    return result.error;
  }

  const body = await readJson(request);

  try {
    const control = requiredString(body?.control, "control");
    const value = body?.value;

    if (value === undefined || value === null) {
      return badRequest("value is required");
    }

    if (process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1" && result.device === "/dev/video-test") {
      return NextResponse.json({ updated: true, controls: mockControls() });
    }

    const controls = await withCameraLock(result.device, async () => {
      await setCameraControl(result.device, control, value);
      return listCameraControls(result.device);
    });
    return NextResponse.json({ updated: true, controls });
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Could not update camera control");
    return NextResponse.json({ error: message }, { status });
  }
}
