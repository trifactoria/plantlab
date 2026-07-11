import { DateTime, IANAZone } from "luxon";

export const DEFAULT_TIME_ZONE = "America/New_York";

export const COMMON_TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export function systemTimeZone() {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(resolved) ? resolved : DEFAULT_TIME_ZONE;
}

export function isValidTimeZone(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/^[+-]\d{2}:?\d{2}$/.test(value.trim()) &&
    IANAZone.isValidZone(value.trim())
  );
}

export function requireValidTimeZone(value: unknown, field = "timeZone") {
  if (!isValidTimeZone(value)) {
    throw new Error(`${field} must be a valid IANA timezone identifier.`);
  }

  return value.trim();
}

export function formatDateTimeInZone(value: Date | string, timeZone: string) {
  return DateTime.fromJSDate(new Date(value))
    .setZone(timeZone)
    .toLocaleString(DateTime.DATETIME_MED);
}

export function localDateTime(value: Date | string, timeZone: string) {
  return DateTime.fromJSDate(new Date(value)).setZone(timeZone);
}

export function localDateKey(value: Date | string, timeZone: string) {
  return localDateTime(value, timeZone).toFormat("yyyy-LL-dd");
}

export function localMonthKey(value: Date | string, timeZone: string) {
  return localDateTime(value, timeZone).toFormat("yyyy-LL");
}

export function localDayRangeUtc(key: string, timeZone: string) {
  const start = DateTime.fromISO(key, { zone: timeZone }).startOf("day");
  const end = start.plus({ days: 1 });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export function localMonthRangeUtc(key: string, timeZone: string) {
  const start = DateTime.fromISO(`${key}-01`, { zone: timeZone }).startOf("day");
  const end = start.plus({ months: 1 });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export function monthLabelInZone(key: string, timeZone: string) {
  return DateTime.fromISO(`${key}-01`, { zone: timeZone }).toLocaleString({
    month: "long",
    year: "numeric",
  });
}

export function dayLabelInZone(key: string, timeZone: string) {
  return DateTime.fromISO(key, { zone: timeZone }).toLocaleString(DateTime.DATE_HUGE);
}

export function minutesToTimeInput(minutes: number | null | undefined) {
  const value = minutes ?? 0;
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function timeInputToMinutes(value: string) {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error("Capture window time must use HH:MM format.");
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const total = hours * 60 + minutes;
  if (!Number.isInteger(total) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error("Capture window time must be between 00:00 and 23:59.");
  }

  return total;
}

export function safeTimeInputToMinutes(value: string) {
  try {
    return timeInputToMinutes(value);
  } catch {
    return null;
  }
}

export function formatWindowMinutes(minutes: number) {
  return DateTime.fromObject({ hour: Math.floor(minutes / 60), minute: minutes % 60 }).toLocaleString(
    DateTime.TIME_SIMPLE,
  );
}
