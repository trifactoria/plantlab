import { NextResponse } from "next/server";
import { getNodeSummaries } from "@/lib/operations/nodeSummary";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getNodeSummaries(prisma));
}
