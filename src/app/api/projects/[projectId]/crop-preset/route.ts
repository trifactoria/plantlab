import { NextResponse } from "next/server";
import { isCropAspectRatioMode } from "@/lib/cropVersions";
import { badRequest, notFound, readJson, requiredNormalizedFraction, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

/**
 * A project's single crop-size suggestion (see ProjectCropPreset in
 * schema.prisma). Sizing/shape only, never a fixed position - it exists
 * purely to speed up setting the first crop for each subsequent plant.
 */
export async function GET(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const preset = await prisma.projectCropPreset.findUnique({ where: { projectId } });
  return NextResponse.json({ preset });
}

/** "Save size as project default" - upserts the one preset for this project. */
export async function PUT(request: Request, context: Context) {
  const { projectId } = await context.params;
  const body = await readJson(request);

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return notFound("Project not found");
    }

    const width = requiredNormalizedFraction(body?.width, "width");
    const height = requiredNormalizedFraction(body?.height, "height");
    const aspectRatioMode = body?.aspectRatioMode;
    if (!isCropAspectRatioMode(aspectRatioMode)) {
      return badRequest("aspectRatioMode must be one of 1:1, 16:9, 9:16, free");
    }

    const preset = await prisma.projectCropPreset.upsert({
      where: { projectId },
      create: { projectId, width, height, aspectRatioMode },
      update: { width, height, aspectRatioMode },
    });

    return NextResponse.json(preset);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
