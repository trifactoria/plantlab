import { DateTime } from "luxon";
import { formatWindowMinutes, isValidTimeZone } from "./timezone";

export function nextAlignedCaptureTime({
  startAt,
  intervalMinutes,
  now = new Date(),
}: {
  startAt: Date;
  intervalMinutes: number;
  now?: Date;
}) {
  const intervalMs = intervalMinutes * 60_000;

  if (intervalMs <= 0) {
    throw new Error("intervalMinutes must be positive");
  }

  if (startAt.getTime() > now.getTime()) {
    return startAt;
  }

  const elapsed = now.getTime() - startAt.getTime();
  const intervalsElapsed = Math.floor(elapsed / intervalMs) + 1;

  return new Date(startAt.getTime() + intervalsElapsed * intervalMs);
}

export type CaptureWindowConfig = {
  timeZone: string;
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
};

export type CaptureScheduleConfig = CaptureWindowConfig & {
  startAt: Date;
  intervalMinutes: number;
};

export function validateCaptureWindowConfig(config: CaptureWindowConfig): string[] {
  const errors: string[] = [];

  if (!isValidTimeZone(config.timeZone)) {
    errors.push("Project timezone must be a valid IANA timezone identifier.");
  }

  if (!config.captureWindowEnabled) {
    return errors;
  }

  for (const [label, value] of [
    ["Capture window start", config.captureWindowStartMinutes],
    ["Capture window end", config.captureWindowEndMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value === null || value < 0 || value > 1439) {
      errors.push(`${label} must be between 00:00 and 23:59.`);
    }
  }

  return errors;
}

export function captureWindowLabel(config: CaptureWindowConfig) {
  if (!config.captureWindowEnabled) {
    return `All day (${config.timeZone})`;
  }

  const start = config.captureWindowStartMinutes;
  const end = config.captureWindowEndMinutes;
  if (start === null || end === null) {
    return `Invalid capture window (${config.timeZone})`;
  }

  if (start === end) {
    return `All day (${config.timeZone}; equal start/end means 24 hours)`;
  }

  return `${formatWindowMinutes(start)} to ${formatWindowMinutes(end)} ${config.timeZone} time`;
}

export function isInsideCaptureWindow(date: Date, config: CaptureWindowConfig) {
  if (!config.captureWindowEnabled) {
    return true;
  }

  const errors = validateCaptureWindowConfig(config);
  if (errors.length > 0) {
    return false;
  }

  const start = config.captureWindowStartMinutes as number;
  const end = config.captureWindowEndMinutes as number;
  if (start === end) {
    return true;
  }

  const local = DateTime.fromJSDate(date).setZone(config.timeZone);
  const minutes = local.hour * 60 + local.minute;

  if (start < end) {
    return minutes >= start && minutes < end;
  }

  return minutes >= start || minutes < end;
}

function localWallMinuteKey(date: Date, timeZone: string) {
  return DateTime.fromJSDate(date).setZone(timeZone).toFormat("yyyy-LL-dd HH:mm");
}

function isDuplicateFallbackWallMinute(date: Date, timeZone: string) {
  const current = DateTime.fromJSDate(date).setZone(timeZone);
  const priorUtc = new Date(date.getTime() - 60 * 60_000);
  const prior = DateTime.fromJSDate(priorUtc).setZone(timeZone);
  return current.offset < prior.offset && localWallMinuteKey(date, timeZone) === localWallMinuteKey(priorUtc, timeZone);
}

export function nextPermittedCaptureTime(config: CaptureScheduleConfig & { now?: Date }) {
  const now = config.now ?? new Date();
  const intervalMs = config.intervalMinutes * 60_000;

  if (intervalMs <= 0) {
    throw new Error("intervalMinutes must be positive");
  }

  const errors = validateCaptureWindowConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  let candidate = nextAlignedCaptureTime({
    startAt: config.startAt,
    intervalMinutes: config.intervalMinutes,
    now,
  });
  const maxIterations = Math.max(1, Math.ceil((370 * 24 * 60) / config.intervalMinutes));

  for (let index = 0; index < maxIterations; index += 1) {
    if (isInsideCaptureWindow(candidate, config) && !isDuplicateFallbackWallMinute(candidate, config.timeZone)) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + intervalMs);
  }

  return null;
}

export function nextPermittedCaptureTimes(config: CaptureScheduleConfig & { now?: Date; count?: number }) {
  const count = config.count ?? 5;
  const captures: Date[] = [];
  let cursor = config.now ?? new Date();

  while (captures.length < count) {
    const next = nextPermittedCaptureTime({ ...config, now: cursor });
    if (!next) {
      break;
    }
    captures.push(next);
    cursor = next;
  }

  return captures;
}
