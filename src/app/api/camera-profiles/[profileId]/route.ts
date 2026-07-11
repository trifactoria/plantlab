import { NextResponse } from "next/server";
import { badRequest, notFound, optionalString, readJson, requiredPositiveInt, requiredString } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ profileId: string }>;
};

function controlsJson(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    JSON.parse(value);
    return value;
  }

  return JSON.stringify(value);
}

export async function PATCH(request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { profileId } = await context.params;
  const body = await readJson(request);

  try {
    const profile = await prisma.cameraProfile.update({
      where: { id: profileId },
      data: {
        name: body?.name === undefined ? undefined : requiredString(body.name, "name"),
        cameraDevice:
          body?.cameraDevice === undefined
            ? undefined
            : requiredString(body.cameraDevice, "cameraDevice"),
        cameraName:
          body?.cameraName === undefined ? undefined : optionalString(body.cameraName),
        cameraStableId:
          body?.cameraStableId === undefined ? undefined : optionalString(body.cameraStableId),
        width:
          body?.width === undefined ? undefined : requiredPositiveInt(body.width, "width"),
        height:
          body?.height === undefined
            ? undefined
            : requiredPositiveInt(body.height, "height"),
        inputFormat:
          body?.inputFormat === undefined
            ? undefined
            : requiredString(body.inputFormat, "inputFormat"),
        controlsJson: controlsJson(body?.controls),
      },
    });

    return NextResponse.json(profile);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not update profile");
  }
}

export async function DELETE(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { profileId } = await context.params;
  const profile = await prisma.cameraProfile.findUnique({
    where: { id: profileId },
    include: { _count: { select: { projects: true } } },
  });

  if (!profile) {
    return notFound("Profile not found");
  }

  if (profile._count.projects > 0) {
    return badRequest("Cannot delete a profile while a project is using it.");
  }

  await prisma.cameraProfile.delete({ where: { id: profileId } });

  return NextResponse.json({ deleted: true, profileId });
}
