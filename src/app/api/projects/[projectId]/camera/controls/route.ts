import { NextResponse } from "next/server";
import { badRequest, notFound, readJson, requiredString } from "@/lib/http";
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

  try {
    const controls = await listCameraControls(result.device);
    return NextResponse.json({ controls });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read camera controls";
    return NextResponse.json({ error: message, controls: [] }, { status: 400 });
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

    await setCameraControl(result.device, control, value);
    const controls = await listCameraControls(result.device);
    return NextResponse.json({ updated: true, controls });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update camera control";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
