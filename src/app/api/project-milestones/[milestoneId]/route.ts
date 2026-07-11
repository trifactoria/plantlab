import { NextResponse } from "next/server";
import { badRequest, notFound, readJson, requiredPositiveInt, requiredString, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ milestoneId: string }>;
};

export async function PATCH(request: Request, context: Context) {
  const { milestoneId } = await context.params;
  const body = await readJson(request);

  try {
    const existing = await prisma.projectMilestone.findUnique({
      where: { id: milestoneId },
      include: { _count: { select: { events: true } } },
    });

    if (!existing) {
      return notFound("Milestone not found");
    }

    const nextKey = body?.key === undefined ? undefined : requiredString(body.key, "key");
    if (nextKey !== undefined && nextKey !== existing.key && existing._count.events > 0) {
      return badRequest("Milestone key cannot be changed after events use it.");
    }

    const milestone = await prisma.projectMilestone.update({
      where: { id: milestoneId },
      data: {
        key: nextKey,
        label: body?.label === undefined ? undefined : requiredString(body.label, "label"),
        sortOrder: body?.sortOrder === undefined ? undefined : requiredPositiveInt(body.sortOrder, "sortOrder"),
        enabled: body?.enabled === undefined ? undefined : body.enabled === true,
      },
    });

    if (body?.label !== undefined) {
      await prisma.plantEvent.updateMany({
        where: { milestoneId },
        data: { type: milestone.label },
      });
    }

    return NextResponse.json(milestone);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}
