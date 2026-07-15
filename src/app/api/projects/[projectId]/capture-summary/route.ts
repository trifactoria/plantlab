import { NextResponse } from "next/server";
import { getProjectCaptureSummaryDetails } from "@/lib/operations/projectCaptureSchedule";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const summary = await getProjectCaptureSummaryDetails(prisma, projectId);
  if (!summary) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json(summary);
}
