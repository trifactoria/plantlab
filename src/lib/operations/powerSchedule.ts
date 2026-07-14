import type { PowerSchedule, PrismaClient } from "@prisma/client";
import {
  isScheduleDueNow,
  nextScheduledRun,
  parseDaysOfWeek,
  serializeDaysOfWeek,
  validatePowerScheduleConfig,
  type PowerScheduleConfig,
} from "../powerSchedule";
import { DEFAULT_TIME_ZONE } from "../timezone";
import { createPowerCommand } from "./powerProtocol";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/powerSchedule.ts is server-only operational code.");
}

const LABEL_MAX_LENGTH = 120;

export type PowerScheduleLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

const noopLogger: PowerScheduleLogger = { info() {}, warn() {}, error() {} };

type RawParsedInput = {
  outletKey?: string;
  action?: string;
  timeOfDay?: string;
  daysOfWeek?: number[];
  timeZone?: string;
  label?: string | null;
  enabled?: boolean;
};

type ParseResult = { ok: true; value: RawParsedInput } | { ok: false; status: 400; error: string };

export async function listPowerSchedules(prisma: PrismaClient, nodeName: string) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName } });
  if (!node) return null;
  const schedules = await prisma.powerSchedule.findMany({
    where: { nodeId: node.id },
    orderBy: [{ outletKey: "asc" }, { timeOfDay: "asc" }],
  });
  return schedules.map(serializeSchedule);
}

export async function createPowerSchedule(prisma: PrismaClient, nodeName: string, raw: unknown) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName }, include: { outlets: true } });
  if (!node) return { ok: false as const, status: 404, error: `No registered node named "${nodeName}".` };

  const parsed = parseRawInput(raw);
  if (!parsed.ok) return parsed;

  if (!parsed.value.outletKey || !parsed.value.action || !parsed.value.timeOfDay) {
    return { ok: false as const, status: 400, error: "outletKey, action, and timeOfDay are required." };
  }

  const config = {
    outletKey: parsed.value.outletKey,
    action: parsed.value.action,
    timeOfDay: parsed.value.timeOfDay,
    daysOfWeek: parsed.value.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
    timeZone: parsed.value.timeZone ?? DEFAULT_TIME_ZONE,
  };

  const errors = validatePowerScheduleConfig(config);
  if (errors.length > 0) return { ok: false as const, status: 400, error: errors.join(" ") };

  const outlet = node.outlets.find((candidate) => candidate.key === config.outletKey);
  if (!outlet) {
    return { ok: false as const, status: 404, error: `Outlet "${config.outletKey}" is not known for node "${nodeName}".` };
  }

  const schedule = await prisma.powerSchedule.create({
    data: {
      nodeId: node.id,
      outletKey: config.outletKey,
      action: config.action,
      timeOfDay: config.timeOfDay,
      daysOfWeek: serializeDaysOfWeek(config.daysOfWeek),
      timeZone: config.timeZone,
      label: parsed.value.label ?? null,
      enabled: parsed.value.enabled ?? true,
    },
  });
  return { ok: true as const, status: 201, schedule: serializeSchedule(schedule) };
}

export async function updatePowerSchedule(prisma: PrismaClient, nodeName: string, scheduleId: string, raw: unknown) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName }, include: { outlets: true } });
  if (!node) return { ok: false as const, status: 404, error: `No registered node named "${nodeName}".` };

  const existing = await prisma.powerSchedule.findUnique({ where: { id: scheduleId } });
  if (!existing || existing.nodeId !== node.id) {
    return { ok: false as const, status: 404, error: "Schedule not found." };
  }

  const parsed = parseRawInput(raw);
  if (!parsed.ok) return parsed;

  const config = {
    outletKey: parsed.value.outletKey ?? existing.outletKey,
    action: parsed.value.action ?? existing.action,
    timeOfDay: parsed.value.timeOfDay ?? existing.timeOfDay,
    daysOfWeek: parsed.value.daysOfWeek ?? parseDaysOfWeek(existing.daysOfWeek),
    timeZone: parsed.value.timeZone ?? existing.timeZone,
  };

  const errors = validatePowerScheduleConfig(config);
  if (errors.length > 0) return { ok: false as const, status: 400, error: errors.join(" ") };

  const outlet = node.outlets.find((candidate) => candidate.key === config.outletKey);
  if (!outlet) {
    return { ok: false as const, status: 404, error: `Outlet "${config.outletKey}" is not known for node "${nodeName}".` };
  }

  const label = parsed.value.label !== undefined ? parsed.value.label : existing.label;
  const enabled = parsed.value.enabled !== undefined ? parsed.value.enabled : existing.enabled;

  const updated = await prisma.powerSchedule.update({
    where: { id: scheduleId },
    data: {
      outletKey: config.outletKey,
      action: config.action,
      timeOfDay: config.timeOfDay,
      daysOfWeek: serializeDaysOfWeek(config.daysOfWeek),
      timeZone: config.timeZone,
      label,
      enabled,
    },
  });
  return { ok: true as const, status: 200, schedule: serializeSchedule(updated) };
}

export async function deletePowerSchedule(prisma: PrismaClient, nodeName: string, scheduleId: string) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName } });
  if (!node) return { ok: false as const, status: 404, error: `No registered node named "${nodeName}".` };

  const existing = await prisma.powerSchedule.findUnique({ where: { id: scheduleId } });
  if (!existing || existing.nodeId !== node.id) {
    return { ok: false as const, status: 404, error: "Schedule not found." };
  }

  await prisma.powerSchedule.delete({ where: { id: scheduleId } });
  return { ok: true as const, status: 200 };
}

export type PowerScheduleTickResult = {
  checkedAt: Date;
  dueCount: number;
  fired: Array<{ scheduleId: string; nodeName: string; outletKey: string; action: string; status: "queued" | "error"; error?: string }>;
};

/**
 * Ticked from the same long-running coordinator process as the capture
 * schedulers (see scripts/camera-service.ts). Re-reads schedules from the
 * database every tick, so create/edit/enable/disable/delete take effect on
 * the next tick without a restart. Never talks to Kasa directly - firing a
 * schedule only ever creates a PowerCommand row for the existing
 * coordinator-to-edge command queue to deliver.
 */
export class PowerScheduler {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;
  private readonly logger: PowerScheduleLogger;

  constructor(deps: { prisma: PrismaClient; now?: () => Date; logger?: PowerScheduleLogger }) {
    this.prisma = deps.prisma;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? noopLogger;
  }

  async tick(): Promise<PowerScheduleTickResult> {
    const checkedAt = this.now();
    const schedules = await this.prisma.powerSchedule.findMany({
      where: { enabled: true },
      include: { node: true },
    });

    const fired: PowerScheduleTickResult["fired"] = [];

    for (const schedule of schedules) {
      const config: PowerScheduleConfig = {
        timeOfDay: schedule.timeOfDay,
        daysOfWeek: parseDaysOfWeek(schedule.daysOfWeek),
        timeZone: schedule.timeZone,
        enabled: schedule.enabled,
      };
      const { due, todayKey } = isScheduleDueNow(config, schedule.lastRunDateKey, checkedAt);
      if (!due) continue;

      const result = await createPowerCommand(this.prisma, schedule.node.name, {
        outletKey: schedule.outletKey,
        action: schedule.action,
        idempotencyKey: `schedule:${schedule.id}:${todayKey}`,
        requestedBy: `schedule:${schedule.id}`,
      });

      // One attempt per local day regardless of outcome - a persistent
      // failure (e.g. a disabled outlet) would otherwise retry and log on
      // every tick until midnight. The failure is still recorded and
      // visible in the UI via lastRunStatus/lastRunError.
      await this.prisma.powerSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunDateKey: todayKey,
          lastRunAt: checkedAt,
          lastRunStatus: result.ok ? "queued" : "error",
          lastRunError: result.ok ? null : result.error,
        },
      });

      if (result.ok) {
        this.logger.info("Power schedule fired", {
          scheduleId: schedule.id,
          node: schedule.node.name,
          outletKey: schedule.outletKey,
          action: schedule.action,
        });
      } else {
        this.logger.warn("Power schedule failed to queue command", {
          scheduleId: schedule.id,
          node: schedule.node.name,
          outletKey: schedule.outletKey,
          error: result.error,
        });
      }

      fired.push({
        scheduleId: schedule.id,
        nodeName: schedule.node.name,
        outletKey: schedule.outletKey,
        action: schedule.action,
        status: result.ok ? "queued" : "error",
        error: result.ok ? undefined : result.error,
      });
    }

    return { checkedAt, dueCount: fired.length, fired };
  }

  /** Power schedules resolve to whole minutes, so a coarse fixed wake driven by the shared refresh interval is sufficient. */
  msUntilNextWake(refreshIntervalMs: number): number {
    return refreshIntervalMs;
  }
}

function serializeSchedule(schedule: PowerSchedule) {
  const daysOfWeek = parseDaysOfWeek(schedule.daysOfWeek);
  const config: PowerScheduleConfig = {
    timeOfDay: schedule.timeOfDay,
    daysOfWeek,
    timeZone: schedule.timeZone,
    enabled: schedule.enabled,
  };
  return {
    id: schedule.id,
    outletKey: schedule.outletKey,
    action: schedule.action,
    timeOfDay: schedule.timeOfDay,
    daysOfWeek,
    timeZone: schedule.timeZone,
    label: schedule.label,
    enabled: schedule.enabled,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    lastRunStatus: schedule.lastRunStatus,
    lastRunError: schedule.lastRunError,
    nextRunAt: nextScheduledRun(config, new Date())?.toISOString() ?? null,
  };
}

function parseRawInput(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, status: 400, error: "Request body must be a JSON object." };
  const value: RawParsedInput = {};

  if (raw.outletKey !== undefined) {
    if (typeof raw.outletKey !== "string") return { ok: false, status: 400, error: "outletKey must be a string." };
    value.outletKey = raw.outletKey;
  }
  if (raw.action !== undefined) {
    if (typeof raw.action !== "string") return { ok: false, status: 400, error: "action must be a string." };
    value.action = raw.action;
  }
  if (raw.timeOfDay !== undefined) {
    if (typeof raw.timeOfDay !== "string") return { ok: false, status: 400, error: "timeOfDay must be a string." };
    value.timeOfDay = raw.timeOfDay;
  }
  if (raw.daysOfWeek !== undefined) {
    if (!Array.isArray(raw.daysOfWeek) || raw.daysOfWeek.some((day) => typeof day !== "number")) {
      return { ok: false, status: 400, error: "daysOfWeek must be an array of numbers." };
    }
    value.daysOfWeek = raw.daysOfWeek as number[];
  }
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone !== "string") return { ok: false, status: 400, error: "timeZone must be a string." };
    value.timeZone = raw.timeZone;
  }
  if (raw.label !== undefined) {
    if (raw.label !== null && typeof raw.label !== "string") {
      return { ok: false, status: 400, error: "label must be a string or null." };
    }
    if (typeof raw.label === "string" && raw.label.trim().length > LABEL_MAX_LENGTH) {
      return { ok: false, status: 400, error: `label must be ${LABEL_MAX_LENGTH} characters or fewer.` };
    }
    value.label = raw.label === null ? null : raw.label.trim() || null;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return { ok: false, status: 400, error: "enabled must be a boolean." };
    value.enabled = raw.enabled;
  }

  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
