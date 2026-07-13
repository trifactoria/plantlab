import { NextResponse } from "next/server";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "@/lib/operations/environmentProtocol";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const body = (await request.json().catch(() => null)) as unknown;
  if (body && typeof body === "object" && !Array.isArray(body) && "nodeName" in body) {
    const nodeName = (body as { nodeName?: unknown }).nodeName;
    if (typeof nodeName === "string" && nodeName.trim() && nodeName.trim() !== auth.node.name) {
      return NextResponse.json({ error: "Authenticated node does not match payload nodeName." }, { status: 403 });
    }
  }

  let events;
  try {
    events = parseEnvironmentBatch(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  try {
    const result = await ingestEnvironmentTelemetry(prisma, auth.node.id, events);
    return NextResponse.json({ status: "ok", ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
