import { DateTime } from "luxon";
import { isValidTimeZone, timeInputToMinutes } from "./timezone";

export const SCHEDULABLE_OUTLET_KEYS = ["fans", "water", "lights"] as const;
export type SchedulableOutletKey = (typeof SCHEDULABLE_OUTLET_KEYS)[number];
export const SCHEDULE_ACTIONS = ["on", "off"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

/**
 * Minutes late a scheduled run is still allowed to fire after a coordinator
 * restart or brief outage. Beyond this window the run is treated as missed
 * and skipped - the next occurrence is calculated instead of backfilling a
 * stale command. See AGENTS.md / task spec: "skip expired runs and
 * calculate the next future occurrence."
 */
export const MISSED_RUN_GRACE_MINUTES = 15;

export type PowerScheduleConfig = {
  timeOfDay: string;
  daysOfWeek: number[];
  timeZone: string;
  enabled: boolean;
};

export function parseDaysOfWeek(raw: string): number[] {
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
}

export function serializeDaysOfWeek(days: number[]): string {
  return Array.from(new Set(days))
    .sort((a, b) => a - b)
    .join(",");
}

export function validatePowerScheduleConfig(config: {
  outletKey: string;
  action: string;
  timeOfDay: string;
  daysOfWeek: number[];
  timeZone: string;
}): string[] {
  const errors: string[] = [];

  if (!(SCHEDULABLE_OUTLET_KEYS as readonly string[]).includes(config.outletKey)) {
    errors.push(`Outlet must be one of ${SCHEDULABLE_OUTLET_KEYS.join(", ")}.`);
  }
  if (!(SCHEDULE_ACTIONS as readonly string[]).includes(config.action)) {
    errors.push(`Action must be one of ${SCHEDULE_ACTIONS.join(", ")}.`);
  }
  try {
    timeInputToMinutes(config.timeOfDay);
  } catch {
    errors.push("timeOfDay must use 24-hour HH:MM format.");
  }
  if (!isValidTimeZone(config.timeZone)) {
    errors.push("timeZone must be a valid IANA timezone identifier.");
  }
  if (config.daysOfWeek.length === 0) {
    errors.push("At least one day of week is required.");
  }
  if (config.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    errors.push("Days of week must be integers between 0 (Sunday) and 6 (Saturday).");
  }

  return errors;
}

/** Luxon ISO weekday (1=Monday..7=Sunday) converted to 0=Sunday..6=Saturday. */
function localWeekday(value: DateTime): number {
  return value.weekday % 7;
}

/**
 * Next future local occurrence of this schedule, strictly after `now`.
 * Returns null when disabled or when no day of week is selected. DST-safe
 * because the wall-clock hour/minute is set directly on a zoned DateTime -
 * luxon resolves the correct UTC instant for that zone on that date.
 */
export function nextScheduledRun(config: PowerScheduleConfig, now: Date = new Date()): Date | null {
  if (!config.enabled || config.daysOfWeek.length === 0) return null;

  let minutes: number;
  try {
    minutes = timeInputToMinutes(config.timeOfDay);
  } catch {
    return null;
  }

  const zonedNow = DateTime.fromJSDate(now).setZone(config.timeZone);

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDay = zonedNow.plus({ days: offset }).startOf("day");
    if (!config.daysOfWeek.includes(localWeekday(candidateDay))) continue;

    const candidate = candidateDay.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
    if (candidate.toMillis() > zonedNow.toMillis()) {
      return candidate.toJSDate();
    }
  }

  return null;
}

export type DueCheckResult = { due: boolean; todayKey: string };

/**
 * Whether a schedule should fire right now. A schedule fires at most once
 * per local calendar day (`lastRunDateKey` guards this - restart-safe,
 * since it's read back from the database on every tick rather than kept
 * only in memory) and only within MISSED_RUN_GRACE_MINUTES of its
 * scheduled time; later than that, today's occurrence is considered missed
 * and is skipped rather than fired late.
 */
export function isScheduleDueNow(
  config: PowerScheduleConfig,
  lastRunDateKey: string | null,
  now: Date = new Date(),
): DueCheckResult {
  const zonedNow = DateTime.fromJSDate(now).setZone(config.timeZone);
  const todayKey = zonedNow.toFormat("yyyy-LL-dd");

  if (!config.enabled) return { due: false, todayKey };
  if (lastRunDateKey === todayKey) return { due: false, todayKey };
  if (!config.daysOfWeek.includes(localWeekday(zonedNow))) return { due: false, todayKey };

  let minutes: number;
  try {
    minutes = timeInputToMinutes(config.timeOfDay);
  } catch {
    return { due: false, todayKey };
  }

  const scheduled = zonedNow.startOf("day").set({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
  const lateMinutes = zonedNow.diff(scheduled, "minutes").minutes;

  if (lateMinutes < 0) return { due: false, todayKey };
  if (lateMinutes > MISSED_RUN_GRACE_MINUTES) return { due: false, todayKey };

  return { due: true, todayKey };
}
