import { NextResponse } from "next/server";
import {
  associateExactLabelEventsWithMilestones,
  ensureDefaultProjectMilestones,
  milestoneKeyFromLabel,
} from "@/lib/experiment";
import { badRequest, optionalString, readJson, requiredString, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) {
    return badRequest("projectId is required");
  }

  await ensureDefaultProjectMilestones(prisma, projectId);
  const milestones = await prisma.projectMilestone.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });

  return NextResponse.json({ milestones });
}

export async function POST(request: Request) {
  const body = await readJson(request);

  try {
    const projectId = requiredString(body?.projectId, "projectId");
    const label = requiredString(body?.label, "label");
    const requestedKey = optionalString(body?.key);
    const key = requestedKey ? milestoneKeyFromLabel(requestedKey) : milestoneKeyFromLabel(label);

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return badRequest("projectId is invalid");
    }

    const maxSort = await prisma.projectMilestone.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });

    const milestone = await prisma.projectMilestone.create({
      data: {
        projectId,
        key,
        label,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        enabled: body?.enabled !== false,
      },
    });

    return NextResponse.json(milestone, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}

export async function PATCH(request: Request) {
  const body = await readJson(request);

  try {
    const projectId = requiredString(body?.projectId, "projectId");
    if (body?.associateExactLabels === true) {
      const updatedCount = await associateExactLabelEventsWithMilestones(prisma, projectId);
      return NextResponse.json({ updatedCount });
    }

    return badRequest("No supported project milestone bulk action was requested.");
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
