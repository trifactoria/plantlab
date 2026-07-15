import { NextResponse } from "next/server";
import { listAvailableProjectCaptureSources } from "@/lib/operations/projectCapture";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeRetired = url.searchParams.get("includeRetired") === "true" || url.searchParams.get("includeUnavailable") === "true";
  const sources = await listAvailableProjectCaptureSources(prisma, { includeRetired });
  return NextResponse.json({ sources });
}
