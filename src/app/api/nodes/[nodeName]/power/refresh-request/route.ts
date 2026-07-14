import { NextResponse } from "next/server";
import { requestPowerStateRefresh } from "@/lib/operations/powerProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  try {
    await requestPowerStateRefresh(prisma, nodeName);
  } catch {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
