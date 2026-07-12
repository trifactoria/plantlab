import { NextResponse } from "next/server";
import { recordHeartbeat, requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const node = await recordHeartbeat(prisma, auth.node.id, {
    hostname: typeof body.hostname === "string" ? body.hostname : null,
    role: typeof body.role === "string" ? body.role : null,
    operatingSystem: typeof body.operatingSystem === "string" ? body.operatingSystem : null,
    architecture: typeof body.architecture === "string" ? body.architecture : null,
    softwareVersion: typeof body.softwareVersion === "string" ? body.softwareVersion : null,
    runtime: typeof body.runtime === "string" ? body.runtime : null,
    protocolVersion: typeof body.protocolVersion === "string" ? body.protocolVersion : null,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : null,
  });

  return NextResponse.json({ status: "ok", node: { name: node.name, role: node.role, lastHeartbeatAt: node.lastHeartbeatAt } });
}
