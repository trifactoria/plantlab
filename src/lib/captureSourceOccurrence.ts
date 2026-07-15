import type { Prisma, PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/captureSourceOccurrence.ts is server-only operational code.");
}

type AnyClient = PrismaClient | Prisma.TransactionClient;

export const CAPTURE_SOURCE_OCCURRENCE_STATUSES = [
  "captured",
  "skipped-illumination-off",
  "skipped-illumination-unknown",
  "skipped-source-disabled",
  "skipped-outside-window",
  "queued",
  "failed",
  "expired",
] as const;

export type CaptureSourceOccurrenceStatus = (typeof CAPTURE_SOURCE_OCCURRENCE_STATUSES)[number];

export async function upsertCaptureSourceOccurrence(
  prisma: AnyClient,
  input: {
    captureSourceId: string;
    scheduledFor: Date;
    status: CaptureSourceOccurrenceStatus;
    skipReason?: string | null;
    agentJobId?: string | null;
    sourceCaptureId?: string | null;
    requestedMode?: { width: number; height: number; inputFormat: string; frameRate: string | null } | null;
    effectiveMode?: { width: number; height: number; inputFormat: string | null; frameRate: string | null } | null;
    capturedAt?: Date | null;
    decisionAt?: Date;
  },
) {
  return prisma.captureSourceOccurrence.upsert({
    where: { captureSourceId_scheduledFor: { captureSourceId: input.captureSourceId, scheduledFor: input.scheduledFor } },
    create: {
      captureSourceId: input.captureSourceId,
      scheduledFor: input.scheduledFor,
      decisionAt: input.decisionAt ?? new Date(),
      status: input.status,
      skipReason: input.skipReason ?? null,
      agentJobId: input.agentJobId ?? null,
      sourceCaptureId: input.sourceCaptureId ?? null,
      requestedWidth: input.requestedMode?.width ?? null,
      requestedHeight: input.requestedMode?.height ?? null,
      requestedInputFormat: input.requestedMode?.inputFormat ?? null,
      requestedFrameRate: input.requestedMode?.frameRate ?? null,
      effectiveWidth: input.effectiveMode?.width ?? null,
      effectiveHeight: input.effectiveMode?.height ?? null,
      effectiveInputFormat: input.effectiveMode?.inputFormat ?? null,
      effectiveFrameRate: input.effectiveMode?.frameRate ?? null,
      capturedAt: input.capturedAt ?? null,
    },
    update: {
      decisionAt: input.decisionAt ?? new Date(),
      status: input.status,
      skipReason: input.skipReason ?? null,
      agentJobId: input.agentJobId ?? undefined,
      sourceCaptureId: input.sourceCaptureId ?? undefined,
      requestedWidth: input.requestedMode?.width ?? undefined,
      requestedHeight: input.requestedMode?.height ?? undefined,
      requestedInputFormat: input.requestedMode?.inputFormat ?? undefined,
      requestedFrameRate: input.requestedMode?.frameRate ?? undefined,
      effectiveWidth: input.effectiveMode?.width ?? undefined,
      effectiveHeight: input.effectiveMode?.height ?? undefined,
      effectiveInputFormat: input.effectiveMode?.inputFormat ?? undefined,
      effectiveFrameRate: input.effectiveMode?.frameRate ?? undefined,
      capturedAt: input.capturedAt ?? undefined,
    },
  });
}
