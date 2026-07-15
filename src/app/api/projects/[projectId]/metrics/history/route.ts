import { NextResponse } from "next/server";
import { getProjectMetricHistory } from "@/lib/operations/metricHistory";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  const result = await getProjectMetricHistory(prisma, projectId, url.searchParams);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.body);
}
