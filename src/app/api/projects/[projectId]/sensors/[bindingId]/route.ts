import { NextResponse } from "next/server";
import { readJson } from "@/lib/http";
import { unlinkProjectSensor, updateProjectSensorBinding } from "@/lib/operations/projectSensors";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ projectId: string; bindingId: string }> };

export async function PATCH(request: Request, context: Context) {
  const { projectId, bindingId } = await context.params;
  const body = await readJson(request);
  try {
    const binding = await updateProjectSensorBinding(prisma, {
      projectId,
      bindingId,
      label: body?.label === undefined ? undefined : typeof body.label === "string" ? body.label : null,
      role: body?.role === undefined ? undefined : typeof body.role === "string" ? body.role : null,
      enabled: body?.enabled === undefined ? undefined : body.enabled === true,
    });
    return NextResponse.json(binding);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update project sensor binding" }, { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 400 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { projectId, bindingId } = await context.params;
  try {
    const binding = await unlinkProjectSensor(prisma, { projectId, bindingId });
    return NextResponse.json({ unlinked: true, binding });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not unlink project sensor binding" }, { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 400 });
  }
}
