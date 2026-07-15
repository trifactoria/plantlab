import { NextResponse } from "next/server";
import { badRequest, readJson } from "@/lib/http";
import { linkProjectSensor, listProjectSensorBindings } from "@/lib/operations/projectSensors";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  try {
    const bindings = await listProjectSensorBindings(prisma, projectId, { includeDisabled: url.searchParams.get("includeDisabled") === "true" });
    return NextResponse.json({ bindings });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not list project sensors" }, { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 400 });
  }
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  const body = await readJson(request);
  try {
    const sensorId = typeof body?.sensorId === "string" ? body.sensorId.trim() : "";
    if (!sensorId) return badRequest("sensorId is required.");
    const binding = await linkProjectSensor(prisma, {
      projectId,
      sensorId,
      label: typeof body?.label === "string" ? body.label : null,
      role: typeof body?.role === "string" ? body.role : null,
      allowHistorical: body?.allowHistorical === true,
    });
    return NextResponse.json(binding, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not link project sensor" }, { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 400 });
  }
}
