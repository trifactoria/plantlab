import { NextResponse } from "next/server";
import { getPowerStateHistory } from "@/lib/operations/powerHistory";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const result = await getPowerStateHistory(prisma, nodeName, new URL(request.url).searchParams);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.body);
}
