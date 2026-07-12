import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

/**
 * A narrow, side-effect-free authenticated endpoint (Part 1 of the
 * credential-recovery task) used only to test whether a credential a node
 * has on disk is still valid - never to authenticate a real protocol
 * action. Unlike heartbeat, this never writes to the node record (no
 * status/lastHeartbeatAt update), so probing a credential can never be
 * mistaken for a real heartbeat. Reveals only pass/fail and basic node
 * identity - the credential itself is never echoed back or logged.
 */
export async function POST(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  return NextResponse.json({ ok: true, node: { name: auth.node.name, role: auth.node.role } });
}
