import { NextResponse } from "next/server";
import { listAvailableProjectSensors } from "@/lib/operations/projectSensors";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const sensors = await listAvailableProjectSensors(prisma);
  return NextResponse.json({ sensors });
}
