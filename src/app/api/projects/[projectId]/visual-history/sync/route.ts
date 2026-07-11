import { NextResponse } from "next/server";
import { repairProjectMissingCrops } from "@/lib/cropVersions";
import { notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

/**
 * Project-wide "Sync visual histories" - see repairProjectMissingCrops for
 * the exact safety guarantees (idempotent, never overwrites, skips
 * unconfigured/disabled plants, project-scoped).
 */
export async function POST(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return notFound("Project not found");
  }

  const result = await repairProjectMissingCrops(prisma, projectId);
  return NextResponse.json(result);
}
