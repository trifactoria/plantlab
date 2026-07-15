import type { Prisma, PrismaClient } from "@prisma/client";
import { dailyWindowCrossesMidnight } from "../captureSourceDefaults";
import { requiredPositiveInt } from "../http";
import { validateCaptureWindowConfig } from "../schedule";
import { requireValidTimeZone } from "../timezone";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/captureSourceConfig.ts is server-only operational code.");
}

export const ILLUMINATION_POLICIES = ["unrestricted", "only-while-on"] as const;
export type IlluminationPolicy = (typeof ILLUMINATION_POLICIES)[number];

export type CaptureSourceScheduleSummary = {
  intervalMinutes: number;
  timeZone: string;
  dailyWindow: { enabled: boolean; start: string | null; end: string | null; crossesMidnight: boolean };
  nextCaptureAt: string | null;
};

export type CaptureSourceConfigInput = {
  name?: string;
  active?: boolean;
  intervalMinutes?: number;
  timeZone?: string;
  dailyWindowEnabled?: boolean;
  dailyWindowStartMinutes?: number | null;
  dailyWindowEndMinutes?: number | null;
  illuminationOutletId?: string | null;
  illuminationPolicy?: string;
};

export async function captureSourceConfigUpdateData(
  prisma: PrismaClient | Prisma.TransactionClient,
  sourceId: string,
  input: CaptureSourceConfigInput,
): Promise<Prisma.CaptureSourceUpdateInput> {
  const existing = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: { assignments: { where: { active: true }, take: 1 } },
  });
  if (!existing) throw new Error("Capture source not found.");

  const data: Prisma.CaptureSourceUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.active !== undefined) data.active = input.active;
  if (input.intervalMinutes !== undefined) data.photoIntervalMinutes = requiredPositiveInt(input.intervalMinutes, "intervalMinutes");
  if (input.timeZone !== undefined) data.timeZone = requireValidTimeZone(input.timeZone);
  if (input.dailyWindowEnabled !== undefined) data.captureWindowEnabled = input.dailyWindowEnabled;
  if (input.dailyWindowStartMinutes !== undefined) data.captureWindowStartMinutes = input.dailyWindowStartMinutes;
  if (input.dailyWindowEndMinutes !== undefined) data.captureWindowEndMinutes = input.dailyWindowEndMinutes;
  if (input.illuminationPolicy !== undefined) {
    if (!ILLUMINATION_POLICIES.includes(input.illuminationPolicy as IlluminationPolicy)) {
      throw new Error(`illuminationPolicy must be one of ${ILLUMINATION_POLICIES.join(", ")}.`);
    }
    data.illuminationPolicy = input.illuminationPolicy;
  }
  if (input.illuminationOutletId !== undefined) {
    if (input.illuminationOutletId === null || input.illuminationOutletId === "") {
      data.illuminationOutlet = { disconnect: true };
    } else {
      const outlet = await prisma.nodeOutlet.findUnique({ where: { id: input.illuminationOutletId } });
      if (!outlet) throw new Error("Illumination outlet not found.");
      if (!outlet.enabled) throw new Error("Illumination outlet must be enabled.");
      const sourceNodeId = existing.assignments[0]?.nodeId ?? null;
      if (sourceNodeId && outlet.nodeId !== sourceNodeId) {
        throw new Error("Illumination outlet must belong to the same node as the capture source assignment.");
      }
      if (!sourceNodeId) {
        throw new Error("Illumination outlet assignment requires a node-backed capture source.");
      }
      data.illuminationOutlet = { connect: { id: outlet.id } };
    }
  }

  const timeZone = input.timeZone ?? existing.timeZone;
  const captureWindowEnabled = input.dailyWindowEnabled ?? existing.captureWindowEnabled;
  const captureWindowStartMinutes =
    input.dailyWindowStartMinutes === undefined ? existing.captureWindowStartMinutes : input.dailyWindowStartMinutes;
  const captureWindowEndMinutes =
    input.dailyWindowEndMinutes === undefined ? existing.captureWindowEndMinutes : input.dailyWindowEndMinutes;
  const errors = validateCaptureWindowConfig({
    timeZone,
    captureWindowEnabled,
    captureWindowStartMinutes,
    captureWindowEndMinutes,
  });
  if (errors.length > 0) throw new Error(errors.join(" "));

  return data;
}

export async function updateCaptureSourceConfig(prisma: PrismaClient, sourceId: string, input: CaptureSourceConfigInput) {
  const data = await captureSourceConfigUpdateData(prisma, sourceId, input);
  return prisma.captureSource.update({ where: { id: sourceId }, data });
}

export function serializeDailyWindow(config: {
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
}) {
  return {
    enabled: config.captureWindowEnabled,
    start: config.captureWindowStartMinutes === null ? null : minutesToClock(config.captureWindowStartMinutes),
    end: config.captureWindowEndMinutes === null ? null : minutesToClock(config.captureWindowEndMinutes),
    crossesMidnight: dailyWindowCrossesMidnight(config.captureWindowStartMinutes, config.captureWindowEndMinutes),
  };
}

export function minutesToClock(minutes: number) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
