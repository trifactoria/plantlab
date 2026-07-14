import type { PowerCommand, PowerSchedule, PrismaClient } from "@prisma/client";
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
  const commandsById = await fetchLastCommands(prisma, schedules);
  return schedules.map((schedule) => serializeSchedule(schedule, schedule.lastCommandId ? (commandsById.get(schedule.lastCommandId) ?? null) : null));
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
  return { ok: true as const, status: 201, schedule: serializeSchedule(schedule, null) };
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

  // Root-cause fix for the 2026-07-14 stuck-timer incident: lastRunDateKey
  // guards "has THIS configuration already fired today" (see
  // isScheduleDueNow). If an edit changes what the schedule actually does
  // (outlet/action/time/days/timezone) but this guard is left pointing at
  // an earlier, different firing (e.g. editing a schedule from "lights ON"
  // to "lights OFF" right after the ON fired), the edited action silently
  // never fires for the rest of that local day - isScheduleDueNow sees
  // lastRunDateKey already matching today and skips it, while the UI kept
  // showing the stale "queued" status from the unrelated earlier firing.
  // Reset all run-tracking fields whenever the due-relevant configuration
  // changes, so "already ran today" always describes the current config.
  const serializedDays = serializeDaysOfWeek(config.daysOfWeek);
  const dueConfigChanged =
    config.outletKey !== existing.outletKey ||
    config.action !== existing.action ||
    config.timeOfDay !== existing.timeOfDay ||
    serializedDays !== existing.daysOfWeek ||
    config.timeZone !== existing.timeZone;

  const updated = await prisma.powerSchedule.update({
    where: { id: scheduleId },
    data: {
      outletKey: config.outletKey,
      action: config.action,
      timeOfDay: config.timeOfDay,
      daysOfWeek: serializedDays,
      timeZone: config.timeZone,
      label,
      enabled,
      ...(dueConfigChanged
        ? { lastRunDateKey: null, lastRunAt: null, lastRunStatus: null, lastRunError: null, lastCommandId: null }
        : {}),
    },
  });
  const lastCommand = updated.lastCommandId ? await prisma.powerCommand.findUnique({ where: { id: updated.lastCommandId } }) : null;
  return { ok: true as const, status: 200, schedule: serializeSchedule(updated, lastCommand) };
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

      const dueAt = Date.now();
      this.logger.info("schedule due", {
        scheduleId: schedule.id,
        node: schedule.node.name,
        outletKey: schedule.outletKey,
        action: schedule.action,
      });

      // updatedAt is included so that editing a schedule in place (which
      // resets lastRunDateKey - see updatePowerSchedule()) gets a fresh
      // idempotency key too. Without it, a same-day re-fire after an edit
      // would collide with the pre-edit firing's key and createPowerCommand
      // would silently return the OLD command (e.g. the earlier "on") as
      // "reused" instead of creating a new one for the edited action.
      // Multiple ticks against an *unedited* schedule on the same day still
      // share one key, which is what actually prevents duplicate commands.
      const result = await createPowerCommand(this.prisma, schedule.node.name, {
        outletKey: schedule.outletKey,
        action: schedule.action,
        idempotencyKey: `schedule:${schedule.id}:${todayKey}:${schedule.updatedAt.getTime()}`,
        requestedBy: `schedule:${schedule.id}`,
      });

      // One attempt per local day regardless of outcome - a persistent
      // failure (e.g. a disabled outlet) would otherwise retry and log on
      // every tick until midnight. The failure is still recorded and
      // visible in the UI via lastRunStatus/lastRunError. lastCommandId
      // lets the UI show the command's real live lifecycle status instead
      // of this static "queued"/"error" label - see serializeSchedule().
      await this.prisma.powerSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunDateKey: todayKey,
          lastRunAt: checkedAt,
          lastRunStatus: result.ok ? "queued" : "error",
          lastRunError: result.ok ? null : result.error,
          lastCommandId: result.ok ? result.command.id : null,
        },
      });

      if (result.ok) {
        this.logger.info("command created", {
          scheduleId: schedule.id,
          commandId: result.command.id,
          node: schedule.node.name,
          outletKey: schedule.outletKey,
          action: schedule.action,
          elapsedMs: Date.now() - dueAt,
        });
      } else {
        this.logger.warn("Power schedule failed to queue command", {
          scheduleId: schedule.id,
          node: schedule.node.name,
          outletKey: schedule.outletKey,
          error: result.error,
          elapsedMs: Date.now() - dueAt,
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

async function fetchLastCommands(prisma: PrismaClient, schedules: PowerSchedule[]): Promise<Map<string, PowerCommand>> {
  const ids = Array.from(new Set(schedules.map((schedule) => schedule.lastCommandId).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const commands = await prisma.powerCommand.findMany({ where: { id: { in: ids } } });
  return new Map(commands.map((command) => [command.id, command]));
}

/**
 * The command's own live status (pending/claimed/succeeded/failed/expired/
 * cancelled) - not the static lastRunStatus "queued"/"error" snapshot from
 * the moment the scheduler created it. Do not treat a schedule as
 * successful just because it queued a command; only "succeeded" here means
 * the coordinator actually observed the resulting outlet state.
 */
function serializeLastCommand(command: PowerCommand | null) {
  if (!command) return null;
  return {
    id: command.id,
    status: command.status,
    requestedAt: command.requestedAt.toISOString(),
    claimedAt: command.claimedAt?.toISOString() ?? null,
    completedAt: command.completedAt?.toISOString() ?? null,
    expiresAt: command.expiresAt.toISOString(),
    actualState: command.actualState,
    stateObservedAt: command.stateObservedAt?.toISOString() ?? null,
    errorCode: command.errorCode,
    errorMessage: command.errorMessage,
  };
}

function serializeSchedule(schedule: PowerSchedule, lastCommand: PowerCommand | null) {
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
    lastCommand: serializeLastCommand(lastCommand),
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
