import { NextResponse } from "next/server";
import {
  type AutofocusPreviousState,
  lockAutofocus,
  restoreAutofocus,
  startAutofocus,
} from "@/lib/autofocus";
import { withCameraLock } from "@/lib/cameraLock";
import { badRequest, cameraErrorInfo, notFound, readJson } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { testCameraMockModeEnabled, testProjectCameraError } from "@/lib/testProjectSafety";
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

  if (project.isTestProject && !testCameraMockModeEnabled()) {
    const blocked = testProjectCameraError();
    return { error: NextResponse.json({ error: blocked.error }, { status: blocked.status }) };
  }

  const device = process.env.CAMERA_DEVICE || project.cameraDevice;

  if (!device) {
    return { error: badRequest("No camera selected for this project.") };
  }

  return { device };
}

function driverFor(device: string) {
  return {
    listControls: () => listCameraControls(device),
    setControl: (control: string, value: string | number | boolean) =>
      setCameraControl(device, control, value),
  };
}

function parsePrevious(body: unknown): AutofocusPreviousState {
  const record = body as { previous?: unknown } | null;
  const previous = record?.previous as Partial<AutofocusPreviousState> | undefined;

  if (
    !previous ||
    typeof previous.autofocusValue !== "boolean" ||
    previous.manualFocusValue === undefined
  ) {
    throw new Error("previous autofocus state is required for this phase");
  }

  return {
    autofocusValue: previous.autofocusValue,
    manualFocusValue: previous.manualFocusValue,
  };
}

export async function POST(request: Request, context: Context) {
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
  const phase = typeof body?.phase === "string" ? body.phase : "start";
  const driver = driverFor(result.device);

  try {
    if (phase === "start") {
      const started = await withCameraLock(result.device, () => startAutofocus(driver));
      return NextResponse.json(started);
    }

    if (phase === "lock") {
      const locked = await withCameraLock(result.device, () => lockAutofocus(driver));
      return NextResponse.json(locked);
    }

    if (phase === "restore") {
      const previous = parsePrevious(body);
      const controls = await withCameraLock(result.device, () => restoreAutofocus(driver, previous));
      return NextResponse.json({ controls });
    }

    return badRequest(`Unknown autofocus phase: ${phase}`);
  } catch (error) {
    const { message, status } = cameraErrorInfo(error, "Autofocus operation failed");
    return NextResponse.json({ error: message }, { status });
  }
}
