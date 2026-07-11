import type { PrismaClient } from "@prisma/client";
import { EVENT_KIND_ORIGIN, ORIGIN_EVENT_TYPE, isOriginEvent } from "@/lib/observationKinds";
import { isUniqueConstraintError } from "@/lib/prismaErrors";

export { EVENT_KIND_ORIGIN, EVENT_KIND_OBSERVATION, ORIGIN_EVENT_TYPE, isOriginEvent } from "@/lib/observationKinds";
export type { EventKind } from "@/lib/observationKinds";

export const DEFAULT_PROJECT_MILESTONES = [
  { key: "first_visible", label: "First visible", sortOrder: 1 },
  { key: "cotyledons_open", label: "Cotyledons open", sortOrder: 2 },
  { key: "first_true_leaf", label: "First true leaf", sortOrder: 3 },
  { key: "root_shoulder_visible", label: "Root shoulder visible", sortOrder: 4 },
  { key: "harvest_ready", label: "Harvest ready", sortOrder: 5 },
  { key: "harvested", label: "Harvested", sortOrder: 6 },
] as const;

export const HARVESTED_MILESTONE_KEY = "harvested";
export const HARVEST_READY_MILESTONE_KEY = "harvest_ready";
export const FIRST_TRUE_LEAF_MILESTONE_KEY = "first_true_leaf";
export const FIRST_VISIBLE_MILESTONE_KEY = "first_visible";

export type CanonicalMilestoneKey = (typeof DEFAULT_PROJECT_MILESTONES)[number]["key"];

export function milestoneKeyFromLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

type MilestoneWritableClient = Pick<PrismaClient, "projectMilestone">;

export async function seedDefaultProjectMilestones(prisma: MilestoneWritableClient, projectId: string) {
  await prisma.projectMilestone.createMany({
    data: DEFAULT_PROJECT_MILESTONES.map((milestone) => ({
      projectId,
      ...milestone,
      enabled: true,
    })),
  });
}

export async function ensureDefaultProjectMilestones(prisma: PrismaClient, projectId: string) {
  const count = await prisma.projectMilestone.count({ where: { projectId } });
  if (count === 0) {
    await seedDefaultProjectMilestones(prisma, projectId);
  }
}

export async function associateExactLabelEventsWithMilestones(prisma: PrismaClient, projectId: string) {
  const milestones = await prisma.projectMilestone.findMany({ where: { projectId } });
  let updatedCount = 0;

  for (const milestone of milestones) {
    const result = await prisma.plantEvent.updateMany({
      where: {
        projectId,
        milestoneId: null,
        type: milestone.label,
      },
      data: { milestoneId: milestone.id },
    });
    updatedCount += result.count;
  }

  return updatedCount;
}

export function originEventData(plant: { id: string; projectId: string; startedAt: Date }) {
  return {
    projectId: plant.projectId,
    plantId: plant.id,
    kind: EVENT_KIND_ORIGIN,
    type: ORIGIN_EVENT_TYPE,
    timestamp: plant.startedAt,
  };
}

type OriginBackfillClient = Pick<PrismaClient, "plant" | "plantEvent">;

/**
 * Idempotent, safe to call on every read. Creates a missing origin event for
 * any plant that doesn't have one yet (e.g. plants created before this
 * feature existed). Races are resolved by the partial unique index on
 * PlantEvent(plantId) WHERE kind='origin' - a losing concurrent insert is
 * simply ignored rather than throwing.
 */
export async function ensurePlantOriginEvents(prisma: OriginBackfillClient, projectId: string) {
  const plants = await prisma.plant.findMany({
    where: { projectId, events: { none: { kind: EVENT_KIND_ORIGIN } } },
    select: { id: true, projectId: true, startedAt: true },
  });

  for (const plant of plants) {
    try {
      await prisma.plantEvent.create({ data: originEventData(plant) });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export function baselineForPlant(project: { plantedAt: Date | null }, plant: { startedAt: Date }) {
  if (project.plantedAt) {
    return { date: project.plantedAt, label: "Project planting date" };
  }

  return { date: plant.startedAt, label: "Plant start date" };
}

export function elapsedMs(from: Date, to: Date) {
  return to.getTime() - from.getTime();
}

export function formatElapsed(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return "";
  }

  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 10) {
    return `${days}d`;
  }
  if (days >= 1) {
    return `${days}d ${hours % 24}h`;
  }

  return `${hours}h ${minutes % 60}m`;
}

export function gramsPerDay(options: {
  weightGrams: number | null | undefined;
  baseline: Date;
  harvestedAt: Date;
}) {
  if (!options.weightGrams || options.weightGrams <= 0) {
    return null;
  }

  const days = elapsedMs(options.baseline, options.harvestedAt) / 86_400_000;
  if (days <= 0) {
    return null;
  }

  return options.weightGrams / days;
}

export function warningNeedsConfirmation(warnings: string[], confirmed: boolean) {
  return warnings.length > 0 && !confirmed;
}
