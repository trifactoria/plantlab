import { NextResponse } from "next/server";
import { badRequest, notFound, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ viewportId: string }>;
};

/**
 * Deactivates (or reactivates) a viewport region in place. This never
 * rewrites geometry or retroactively touches derived photos already
 * created under this viewport - it only stops the region from being
 * resolved for any future capture, exactly like disabling a plant's crop
 * version leaves history alone.
 */
export async function PATCH(request: Request, context: Context) {
  const { viewportId } = await context.params;
  const existing = await prisma.projectViewport.findUnique({ where: { id: viewportId } });
  if (!existing) {
    return notFound("Viewport not found");
  }

  const body = await readJson(request);
  if (typeof body?.active !== "boolean") {
    return badRequest("active (boolean) is required");
  }

  const viewport = await prisma.projectViewport.update({
    where: { id: viewportId },
    data: { active: body.active },
    include: { project: { select: { id: true, name: true } } },
  });

  return NextResponse.json(viewport);
}
