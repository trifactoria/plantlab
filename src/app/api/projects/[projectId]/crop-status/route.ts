import { NextResponse } from "next/server";
import { computeProjectCropStatus } from "@/lib/cropVersions";
import { notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

/**
 * Project-level crop-readiness summary (see computeProjectCropStatus) - lets
 * the project page show configured/unconfigured counts without requiring
 * the user to open every plant page.
 */
export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return notFound("Project not found");
  }

  const status = await computeProjectCropStatus(prisma, projectId);
  return NextResponse.json(status);
}
