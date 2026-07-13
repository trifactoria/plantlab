import type { CaptureSource, PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/captureSourceDoctor.ts is server-only operational code.");
}

export type SuspiciousReason = "no-captures" | "no-viewports" | "unnamed" | "recently-created";

export type CaptureSourceInspection = {
  source: CaptureSource;
  captureCount: number;
  viewportCount: number;
  suspicious: boolean;
  reasons: SuspiciousReason[];
};

const RECENTLY_CREATED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Flags names that look like they came from a stray answer to the wrong
 * prompt (e.g. a bare menu-choice digit like "2") rather than something a
 * person typed on purpose.
 */
export function looksLikeAccidentalName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^\d+$/.test(trimmed)) return true;
  if (/^(untitled|new|camera|source)$/i.test(trimmed)) return true;
  return false;
}

export async function inspectCaptureSource(prisma: PrismaClient, source: CaptureSource): Promise<CaptureSourceInspection> {
  const [captureCount, viewportCount] = await Promise.all([
    prisma.sourceCapture.count({ where: { captureSourceId: source.id } }),
    prisma.projectViewport.count({ where: { captureSourceId: source.id } }),
  ]);

  const reasons: SuspiciousReason[] = [];
  if (captureCount === 0) reasons.push("no-captures");
  if (viewportCount === 0) reasons.push("no-viewports");
  if (looksLikeAccidentalName(source.name)) reasons.push("unnamed");
  if (Date.now() - source.createdAt.getTime() < RECENTLY_CREATED_MS) reasons.push("recently-created");

  // Never flag a source that has real activity, even if its name looks
  // unusual - only genuinely unused sources with an accidental-looking name
  // or recent failed-onboarding origin are worth asking the user about.
  const suspicious = captureCount === 0 && viewportCount === 0 && (reasons.includes("unnamed") || reasons.includes("recently-created"));

  return { source, captureCount, viewportCount, suspicious, reasons };
}

export async function findSuspiciousCaptureSources(prisma: PrismaClient): Promise<CaptureSourceInspection[]> {
  const sources = await prisma.captureSource.findMany({ orderBy: { createdAt: "desc" } });
  const inspections = await Promise.all(sources.map((source) => inspectCaptureSource(prisma, source)));
  return inspections.filter((inspection) => inspection.suspicious);
}

export async function inspectCaptureSourceByIdOrName(prisma: PrismaClient, idOrName: string): Promise<CaptureSourceInspection> {
  const source = (await prisma.captureSource.findUnique({ where: { id: idOrName } })) ?? (await prisma.captureSource.findFirst({ where: { name: idOrName } }));
  if (!source) {
    throw new Error(`No capture source found with id or name "${idOrName}".`);
  }
  return inspectCaptureSource(prisma, source);
}

export function describeReasons(reasons: SuspiciousReason[]): string[] {
  return reasons.map((reason) => {
    switch (reason) {
      case "no-captures":
        return "has no captures";
      case "no-viewports":
        return "is not used by any project viewport";
      case "unnamed":
        return "name does not look intentional (e.g. a bare number)";
      case "recently-created":
        return "was created recently";
    }
  });
}

export async function renameCaptureSource(prisma: PrismaClient, id: string, name: string): Promise<CaptureSource> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("A capture source name cannot be empty.");
  }
  return prisma.captureSource.update({ where: { id }, data: { name: trimmed } });
}

/**
 * Deletes a capture source, but only when it truly has no captures and no
 * project viewports - callers must never invoke this automatically. FK
 * cascades in the schema (NodeCamera.captureSourceId SetNull,
 * NodeCameraAssignment/AgentCaptureJob Cascade) detach any linked node
 * camera and clean up empty assignments/jobs.
 */
export async function deleteEmptyCaptureSource(prisma: PrismaClient, id: string): Promise<CaptureSource> {
  const source = await prisma.captureSource.findUniqueOrThrow({ where: { id } });
  const inspection = await inspectCaptureSource(prisma, source);
  if (inspection.captureCount > 0 || inspection.viewportCount > 0) {
    throw new Error(
      `Refusing to delete capture source "${source.name}": it has ${inspection.captureCount} capture(s) and ${inspection.viewportCount} viewport(s).`,
    );
  }
  return prisma.captureSource.delete({ where: { id } });
}
