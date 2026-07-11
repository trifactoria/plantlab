import { NextResponse } from "next/server";
import { badRequest, optionalString, readJson, requiredPositiveInt, requiredString } from "@/lib/http";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function controlsJson(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    JSON.parse(value);
    return value;
  }

  return JSON.stringify(value);
}

export async function GET(request: Request) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { searchParams } = new URL(request.url);
  const cameraDevice = searchParams.get("cameraDevice") ?? undefined;
  const profiles = await prisma.cameraProfile.findMany({
    where: { cameraDevice },
    include: { _count: { select: { projects: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ profiles });
}

export async function POST(request: Request) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const body = await readJson(request);

  try {
    const profile = await prisma.cameraProfile.create({
      data: {
        name: requiredString(body?.name, "name"),
        cameraDevice: requiredString(body?.cameraDevice, "cameraDevice"),
        cameraName: optionalString(body?.cameraName),
        cameraStableId: optionalString(body?.cameraStableId),
        width: requiredPositiveInt(body?.width, "width"),
        height: requiredPositiveInt(body?.height, "height"),
        inputFormat: requiredString(body?.inputFormat, "inputFormat"),
        controlsJson: controlsJson(body?.controls),
      },
    });

    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Could not create profile");
  }
}
