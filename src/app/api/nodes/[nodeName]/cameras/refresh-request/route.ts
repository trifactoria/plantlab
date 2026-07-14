import { NextResponse } from "next/server";
import { requestCameraInventoryRefresh } from "@/lib/operations/agentProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  try {
    await requestCameraInventoryRefresh(prisma, nodeName);
  } catch {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
