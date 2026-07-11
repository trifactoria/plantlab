import { NextResponse } from "next/server";
import { loadProjectCropSetupData } from "@/lib/cropVersions";
import { badRequest, notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

/**
 * Batch data for the guided project crop-setup wizard - see
 * loadProjectCropSetupData for the shared implementation used by both this
 * route (client-side refetch when the user switches the representative
 * photo) and the server-rendered crop-setup page's initial load.
 */
export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return notFound("Project not found");
  }

  const { searchParams } = new URL(request.url);
  const data = await loadProjectCropSetupData(prisma, projectId, searchParams.get("photoId"));

  if (!data) {
    return badRequest("photoId is invalid for this project, or the project has no photos yet");
  }

  return NextResponse.json(data);
}
