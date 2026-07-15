import { NextResponse } from "next/server";
import { nearestPhotoEnvironment } from "@/lib/operations/projectSensors";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ projectId: string; photoId: string }> };

export async function GET(request: Request, context: Context) {
  const { projectId, photoId } = await context.params;
  const url = new URL(request.url);
  const maxDistanceMs = url.searchParams.has("maxDistanceMs") ? Number(url.searchParams.get("maxDistanceMs")) : undefined;
  try {
    return NextResponse.json(await nearestPhotoEnvironment(prisma, { projectId, photoId, maxDistanceMs }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve photo environment" }, { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 400 });
  }
}
