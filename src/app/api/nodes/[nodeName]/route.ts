import { NextResponse } from "next/server";
import { getNodeSummary } from "@/lib/operations/nodeDetail";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const summary = await getNodeSummary(prisma, nodeName);
  if (!summary) {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }
  return NextResponse.json(summary);
}
