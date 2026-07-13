import { NextResponse } from "next/server";
import { getInventoryRefreshRequest, requireAgentAuth } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(prisma, request);
  if (auth instanceof Response) return auth;

  const requestedAt = await getInventoryRefreshRequest(prisma, auth.node.id);
  return NextResponse.json({
    requested: Boolean(requestedAt),
    requestedAt: requestedAt?.toISOString() ?? null,
  });
}
