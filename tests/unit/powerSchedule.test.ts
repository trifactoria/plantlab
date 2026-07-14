import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  MISSED_RUN_GRACE_MINUTES,
  isScheduleDueNow,
  nextScheduledRun,
  parseDaysOfWeek,
  serializeDaysOfWeek,
  validatePowerScheduleConfig,
} from "../../src/lib/powerSchedule";

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describe("powerSchedule config helpers", () => {
  it("round-trips days of week through the storage string", () => {
    expect(parseDaysOfWeek("0,1,2,3,4,5,6")).toEqual(EVERY_DAY);
    expect(parseDaysOfWeek("1,3,5")).toEqual([1, 3, 5]);
    expect(serializeDaysOfWeek([5, 1, 3, 1])).toBe("1,3,5");
  });

  it("validates outlet, action, time format, timezone, and non-empty days", () => {
    const ok = validatePowerScheduleConfig({ outletKey: "lights", action: "on", timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York" });
    expect(ok).toEqual([]);

    expect(validatePowerScheduleConfig({ outletKey: "water", action: "on", timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York" }).length).toBeGreaterThan(0);
    expect(validatePowerScheduleConfig({ outletKey: "lights", action: "pulse", timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York" }).length).toBeGreaterThan(0);
    expect(validatePowerScheduleConfig({ outletKey: "lights", action: "on", timeOfDay: "25:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York" }).length).toBeGreaterThan(0);
    expect(validatePowerScheduleConfig({ outletKey: "lights", action: "on", timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "Not/AZone" }).length).toBeGreaterThan(0);
    expect(validatePowerScheduleConfig({ outletKey: "lights", action: "on", timeOfDay: "07:00", daysOfWeek: [], timeZone: "America/New_York" }).length).toBeGreaterThan(0);
  });
});

describe("nextScheduledRun", () => {
  it("returns the next future occurrence, not today's if already passed", () => {
    const config = { timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York", enabled: true };

    const beforeToday = new Date("2026-07-14T10:00:00.000Z"); // 06:00 EDT - before 07:00
    const next1 = nextScheduledRun(config, beforeToday);
    expect(next1).not.toBeNull();
    expect(DateTime.fromJSDate(next1!).setZone("America/New_York").toFormat("yyyy-LL-dd HH:mm")).toBe("2026-07-14 07:00");

    const afterToday = new Date("2026-07-14T13:00:00.000Z"); // 09:00 EDT - after 07:00
    const next2 = nextScheduledRun(config, afterToday);
    expect(DateTime.fromJSDate(next2!).setZone("America/New_York").toFormat("yyyy-LL-dd HH:mm")).toBe("2026-07-15 07:00");
  });

  it("respects a restricted day-of-week selection", () => {
    // 2026-07-14 is a Tuesday. Only Mondays (1) selected.
    const config = { timeOfDay: "07:00", daysOfWeek: [1], timeZone: "America/New_York", enabled: true };
    const now = new Date("2026-07-14T12:00:00.000Z");
    const next = nextScheduledRun(config, now);
    const zoned = DateTime.fromJSDate(next!).setZone("America/New_York");
    expect(zoned.weekday).toBe(1); // Monday
    expect(zoned.toFormat("yyyy-LL-dd")).toBe("2026-07-20");
  });

  it("returns null when disabled or no days selected", () => {
    expect(nextScheduledRun({ timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York", enabled: false })).toBeNull();
    expect(nextScheduledRun({ timeOfDay: "07:00", daysOfWeek: [], timeZone: "America/New_York", enabled: true })).toBeNull();
  });

  it("keeps the configured local wall-clock time across a DST transition (America/New_York, spring-forward 2026-03-08)", () => {
    const config = { timeOfDay: "07:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York", enabled: true };

    const beforeDst = nextScheduledRun(config, new Date("2026-03-01T04:00:00.000Z"));
    const afterDst = nextScheduledRun(config, new Date("2026-03-15T04:00:00.000Z"));

    expect(DateTime.fromJSDate(beforeDst!).setZone("America/New_York").toFormat("HH:mm")).toBe("07:00");
    expect(DateTime.fromJSDate(afterDst!).setZone("America/New_York").toFormat("HH:mm")).toBe("07:00");

    // EST is UTC-5 (offset -300 minutes); EDT is UTC-4 (offset -240 minutes).
    expect(DateTime.fromJSDate(beforeDst!).setZone("America/New_York").offset).toBe(-300);
    expect(DateTime.fromJSDate(afterDst!).setZone("America/New_York").offset).toBe(-240);
  });
});

describe("isScheduleDueNow (idempotency + missed-run policy)", () => {
  const config = { timeOfDay: "08:00", daysOfWeek: EVERY_DAY, timeZone: "America/New_York", enabled: true };

  it("is due right at the scheduled minute and not yet run today", () => {
    const now = new Date("2026-07-14T12:00:00.000Z"); // 08:00 EDT
    const result = isScheduleDueNow(config, null, now);
    expect(result.due).toBe(true);
    expect(result.todayKey).toBe("2026-07-14");
  });

  it("is not due before the scheduled time", () => {
    const now = new Date("2026-07-14T11:00:00.000Z"); // 07:00 EDT
    expect(isScheduleDueNow(config, null, now).due).toBe(false);
  });

  it("stays due within the missed-run grace window after a restart", () => {
    const lateBy = MISSED_RUN_GRACE_MINUTES - 1;
    const now = new Date(new Date("2026-07-14T12:00:00.000Z").getTime() + lateBy * 60_000);
    expect(isScheduleDueNow(config, null, now).due).toBe(true);
  });

  it("skips a run missed by more than the grace window (conservative missed-run policy)", () => {
    const now = new Date("2026-07-14T18:00:00.000Z"); // 14:00 EDT, 6 hours late
    expect(isScheduleDueNow(config, null, now).due).toBe(false);
  });

  it("does not fire twice on the same local day once lastRunDateKey matches (restart-safe idempotency)", () => {
    const now = new Date("2026-07-14T12:05:00.000Z");
    expect(isScheduleDueNow(config, "2026-07-14", now).due).toBe(false);
  });

  it("fires again the following day even if it already ran today", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect(isScheduleDueNow(config, "2026-07-14", now).due).toBe(true);
  });

  it("does not fire on a day of week that is not selected", () => {
    // 2026-07-14 is a Tuesday (weekday 2); restrict to Mondays only.
    const mondaysOnly = { ...config, daysOfWeek: [1] };
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(isScheduleDueNow(mondaysOnly, null, now).due).toBe(false);
  });

  it("is never due when disabled", () => {
    const disabled = { ...config, enabled: false };
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(isScheduleDueNow(disabled, null, now).due).toBe(false);
  });
});
