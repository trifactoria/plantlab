import { NextResponse } from "next/server";
import { getMetricHistory } from "@/lib/operations/metricHistory";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const result = await getMetricHistory(prisma, nodeName, new URL(request.url).searchParams);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.body);
}
