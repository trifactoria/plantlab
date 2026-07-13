import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { ingestPowerState, parsePowerStateReport } from "@/lib/operations/powerProtocol";
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

  let outlets;
  try {
    outlets = parsePowerStateReport(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const result = await ingestPowerState(prisma, auth.node.id, outlets);
  return NextResponse.json({ status: "ok", ...result });
}
