import type { Prisma, PrismaClient, ProjectViewport, SourceCapture } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/projectSampling.ts is server-only operational code.");
}

type AnyClient = PrismaClient | Prisma.TransactionClient;

export type SamplingDecision =
  | { due: true; sampleSlotAt: Date }
  | { due: false; sampleSlotAt: Date | null; reason: "disabled" | "not-aligned" | "not-yet-effective" };

export function nearestProjectSampleSlot(input: {
  captureAt: Date;
  anchorAt: Date;
  intervalMinutes: number;
  toleranceMinutes: number;
}): Date | null {
  if (input.intervalMinutes <= 0) return null;
  if (input.captureAt.getTime() < input.anchorAt.getTime()) return null;
  const intervalMs = input.intervalMinutes * 60_000;
  const elapsed = input.captureAt.getTime() - input.anchorAt.getTime();
  const nearestIndex = Math.round(elapsed / intervalMs);
  const slot = new Date(input.anchorAt.getTime() + nearestIndex * intervalMs);
  const toleranceMs = input.toleranceMinutes * 60_000;
  return Math.abs(input.captureAt.getTime() - slot.getTime()) <= toleranceMs ? slot : null;
}

export function projectSamplingDecision(
  viewport: Pick<ProjectViewport, "effectiveFrom" | "samplingEnabled" | "samplingIntervalMinutes" | "samplingAnchorAt"> & {
    project: { photoIntervalMinutes: number };
  },
  captureAt: Date,
  sourceIntervalMinutes: number,
): SamplingDecision {
  if (!viewport.samplingEnabled) return { due: false, sampleSlotAt: null, reason: "disabled" };
  if (captureAt.getTime() < viewport.effectiveFrom.getTime()) {
    return { due: false, sampleSlotAt: null, reason: "not-yet-effective" };
  }
  const intervalMinutes = viewport.samplingIntervalMinutes ?? viewport.project.photoIntervalMinutes;
  const slot = nearestProjectSampleSlot({
    captureAt,
    anchorAt: viewport.samplingAnchorAt ?? viewport.effectiveFrom,
    intervalMinutes,
    toleranceMinutes: sourceIntervalMinutes / 2,
  });
  return slot ? { due: true, sampleSlotAt: slot } : { due: false, sampleSlotAt: null, reason: "not-aligned" };
}

export async function resolveDueSampleViewportsForSourceCapture(
  prisma: PrismaClient,
  sourceCapture: SourceCapture & { captureSource: { photoIntervalMinutes: number } },
) {
  if (!sourceCapture.scheduledFor) {
    return {
      mode: "manual" as const,
      viewports: await resolveActiveViewportsForSource(prisma, sourceCapture.captureSourceId, sourceCapture.timestamp),
    };
  }

  const viewports = await prisma.projectViewport.findMany({
    where: { captureSourceId: sourceCapture.captureSourceId, active: true, effectiveFrom: { lte: sourceCapture.timestamp } },
    orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
    distinct: ["projectId"],
    include: { project: { select: { photoIntervalMinutes: true } } },
  });

  return {
    mode: "scheduled" as const,
    viewports: viewports.flatMap((viewport) => {
      const decision = projectSamplingDecision(viewport, sourceCapture.scheduledFor ?? sourceCapture.timestamp, sourceCapture.captureSource.photoIntervalMinutes);
      return decision.due ? [{ viewport, sampleSlotAt: decision.sampleSlotAt }] : [];
    }),
  };
}

async function resolveActiveViewportsForSource(
  client: Pick<AnyClient, "projectViewport">,
  captureSourceId: string,
  timestamp: Date,
): Promise<ProjectViewport[]> {
  return client.projectViewport.findMany({
    where: { captureSourceId, active: true, effectiveFrom: { lte: timestamp } },
    orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
    distinct: ["projectId"],
  });
}

export async function recordMissingProjectSamplesForSourceSlot(
  prisma: AnyClient,
  input: { captureSourceId: string; scheduledFor: Date; reason: string },
) {
  const source = await prisma.captureSource.findUnique({
    where: { id: input.captureSourceId },
    select: { photoIntervalMinutes: true },
  });
  if (!source) return [];

  const viewports = await prisma.projectViewport.findMany({
    where: { captureSourceId: input.captureSourceId, active: true, effectiveFrom: { lte: input.scheduledFor } },
    orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
    distinct: ["projectId"],
    include: { project: { select: { photoIntervalMinutes: true } } },
  });

  const samples = [];
  for (const viewport of viewports) {
    const decision = projectSamplingDecision(viewport, input.scheduledFor, source.photoIntervalMinutes);
    if (!decision.due) continue;
    const sample = await prisma.projectSourceSample
      .upsert({
        where: {
          projectId_viewportId_sampleSlotAt: {
            projectId: viewport.projectId,
            viewportId: viewport.id,
            sampleSlotAt: decision.sampleSlotAt,
          },
        },
        create: {
          projectId: viewport.projectId,
          viewportId: viewport.id,
          captureSourceId: input.captureSourceId,
          sampleSlotAt: decision.sampleSlotAt,
          status: "missing",
          missingReason: input.reason,
        },
        update: {
          status: "missing",
          missingReason: input.reason,
        },
      })
      .catch(() => null);
    if (sample) samples.push(sample);
  }
  return samples;
}
