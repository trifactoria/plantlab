import { NextResponse } from "next/server";
import { getLatestEnvironmentStatus } from "@/lib/operations/environmentProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const status = await getLatestEnvironmentStatus(prisma, nodeName);
  if (!status) {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }
  return NextResponse.json(status);
}
