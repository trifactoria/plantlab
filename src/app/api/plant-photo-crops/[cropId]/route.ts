import { NextResponse } from "next/server";
import { validateCrop } from "@/lib/crops";
import { badRequest, notFound, readJson, serverError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ cropId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { cropId } = await context.params;
  const crop = await prisma.plantPhotoCrop.findUnique({
    where: { id: cropId },
    include: { plant: true, photo: true },
  });

  if (!crop) {
    return notFound("Crop not found");
  }

  return NextResponse.json(crop);
}

export async function PATCH(request: Request, context: Context) {
  const { cropId } = await context.params;
  const body = await readJson(request);

  try {
    const existing = await prisma.plantPhotoCrop.findUnique({ where: { id: cropId } });

    if (!existing) {
      return notFound("Crop not found");
    }

    const cropX = body?.cropX === undefined ? existing.cropX : Number(body.cropX);
    const cropY = body?.cropY === undefined ? existing.cropY : Number(body.cropY);
    const cropWidth = body?.cropWidth === undefined ? existing.cropWidth : Number(body.cropWidth);
    const cropHeight = body?.cropHeight === undefined ? existing.cropHeight : Number(body.cropHeight);

    validateCrop({ cropX, cropY, cropWidth, cropHeight });

    const updated = await prisma.plantPhotoCrop.update({
      where: { id: cropId },
      data: { cropX, cropY, cropWidth, cropHeight, createdMethod: "manual", sourceCropId: null },
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      return badRequest(error.message);
    }

    return serverError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { cropId } = await context.params;
  const existing = await prisma.plantPhotoCrop.findUnique({ where: { id: cropId } });

  if (!existing) {
    return notFound("Crop not found");
  }

  await prisma.plantPhotoCrop.delete({ where: { id: cropId } });

  return NextResponse.json({ deleted: true, cropId });
}
