import { NextResponse } from "next/server";
import { createPowerCommand } from "@/lib/operations/powerProtocol";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request, context: { params: Promise<{ nodeName: string; outletKey: string }> }) {
  const { nodeName, outletKey } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await createPowerCommand(prisma, nodeName, {
    outletKey,
    action: typeof body.action === "string" ? body.action : "",
    durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : null,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
    requestedBy: "api",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      status: result.command.status,
      reused: result.reused,
      command: {
        id: result.command.id,
        outletKey: result.command.outletKey,
        action: result.command.action,
        durationSeconds: result.command.durationSeconds,
        requestedAt: result.command.requestedAt.toISOString(),
        expiresAt: result.command.expiresAt.toISOString(),
      },
    },
    { status: result.status },
  );
}
