import { NextResponse } from "next/server";
import { repairMissingCrops } from "@/lib/cropVersions";
import { notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ plantId: string }>;
};

/**
 * Idempotent missing-frame repair. Fills only gaps (photos with an
 * applicable crop version but no PlantPhotoCrop yet); never overwrites an
 * existing row and never invents a crop before the plant's first version.
 * Safe to call repeatedly - see src/lib/cropVersions.ts.
 */
export async function POST(_request: Request, context: Context) {
  const { plantId } = await context.params;
  const plant = await prisma.plant.findUnique({ where: { id: plantId } });

  if (!plant) {
    return notFound("Plant not found");
  }

  const result = await repairMissingCrops(prisma, plantId);
  return NextResponse.json(result);
}
