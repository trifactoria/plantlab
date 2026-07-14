import { NextResponse } from "next/server";
import { getNodeTimeline, type NodeTimelineFilter } from "@/lib/operations/nodeDetail";
import { prisma } from "@/lib/prisma";

const VALID_FILTERS: NodeTimelineFilter[] = ["all", "sensors", "power", "cameras", "agent"];

export async function GET(request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const url = new URL(request.url);
  const rawFilter = url.searchParams.get("filter") ?? "all";
  const filter = VALID_FILTERS.includes(rawFilter as NodeTimelineFilter) ? (rawFilter as NodeTimelineFilter) : "all";

  const entries = await getNodeTimeline(prisma, nodeName, filter);
  if (!entries) {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }
  return NextResponse.json({ entries });
}
