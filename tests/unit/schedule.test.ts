import { describe, expect, it } from "vitest";
import {
  isInsideCaptureWindow,
  nextAlignedCaptureTime,
  nextPermittedCaptureTime,
  validateCaptureWindowConfig,
} from "../../src/lib/schedule";
import { dayKey, groupPhotosByDay, localDayRange } from "../../src/lib/gallery";
import { isValidTimeZone } from "../../src/lib/timezone";

describe("nextAlignedCaptureTime", () => {
  it("returns the start time when the schedule has not started yet", () => {
    const startAt = new Date("2026-07-10T17:00:00Z");
    const now = new Date("2026-07-10T16:55:00Z");

    const next = nextAlignedCaptureTime({ startAt, intervalMinutes: 30, now });

    expect(next.toISOString()).toBe(startAt.toISOString());
  });

  it("returns the next aligned slot shortly after start (5:17 PM -> 5:30 PM example)", () => {
    const startAt = new Date("2026-07-10T17:00:00Z");
    const now = new Date("2026-07-10T17:17:00Z");

    const next = nextAlignedCaptureTime({ startAt, intervalMinutes: 30, now });

    expect(next.toISOString()).toBe(new Date("2026-07-10T17:30:00Z").toISOString());
  });

  it("skips missed intervals instead of backfilling them (down 5:00 PM - 7:12 PM example)", () => {
    const startAt = new Date("2026-07-10T17:00:00Z");
    const now = new Date("2026-07-10T19:12:00Z");

    const next = nextAlignedCaptureTime({ startAt, intervalMinutes: 30, now });

    // Several 30-minute slots (5:30, 6:00, 6:30, 7:00) elapsed while "down",
    // but only the next future one is scheduled - never a catch-up burst.
    expect(next.toISOString()).toBe(new Date("2026-07-10T19:30:00Z").toISOString());
  });

  it("stays aligned to the original start time regardless of when it's queried", () => {
    const startAt = new Date("2026-07-10T17:00:00Z");

    const next = nextAlignedCaptureTime({
      startAt,
      intervalMinutes: 45,
      now: new Date("2026-07-11T09:03:00Z"),
    });

    // Every returned slot must fall exactly on startAt + N * interval.
    const elapsedMinutes = (next.getTime() - startAt.getTime()) / 60_000;
    expect(elapsedMinutes % 45).toBe(0);
    expect(next.getTime()).toBeGreaterThan(new Date("2026-07-11T09:03:00Z").getTime());
  });
});

describe("timezone-aware capture windows", () => {
  const baseConfig = {
    timeZone: "America/New_York",
    captureWindowEnabled: true,
    captureWindowStartMinutes: 6 * 60,
    captureWindowEndMinutes: 22 * 60,
  };

  it("validates IANA timezones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("-04:00")).toBe(false);
    expect(validateCaptureWindowConfig({ ...baseConfig, timeZone: "Nope/Zone" })).toContain(
      "Project timezone must be a valid IANA timezone identifier.",
    );
  });

  it("handles normal and equal daily windows", () => {
    expect(isInsideCaptureWindow(new Date("2026-07-10T12:00:00Z"), baseConfig)).toBe(true);
    expect(isInsideCaptureWindow(new Date("2026-07-10T03:00:00Z"), baseConfig)).toBe(false);
    expect(
      isInsideCaptureWindow(new Date("2026-07-10T03:00:00Z"), {
        ...baseConfig,
        captureWindowStartMinutes: 8 * 60,
        captureWindowEndMinutes: 8 * 60,
      }),
    ).toBe(true);
  });

  it("handles overnight windows", () => {
    const overnight = {
      ...baseConfig,
      captureWindowStartMinutes: 20 * 60,
      captureWindowEndMinutes: 6 * 60,
    };

    expect(isInsideCaptureWindow(new Date("2026-07-11T02:00:00Z"), overnight)).toBe(true);
    expect(isInsideCaptureWindow(new Date("2026-07-10T16:00:00Z"), overnight)).toBe(false);
  });

  it("returns the next aligned occurrence inside the allowed window", () => {
    const next = nextPermittedCaptureTime({
      ...baseConfig,
      startAt: new Date("2026-07-10T10:00:00Z"),
      intervalMinutes: 30,
      now: new Date("2026-07-11T03:15:00Z"),
    });

    expect(next?.toISOString()).toBe("2026-07-11T10:00:00.000Z");
  });

  it("preserves cadence when the interval does not divide the window", () => {
    const startAt = new Date("2026-07-10T10:10:00Z");
    const next = nextPermittedCaptureTime({
      ...baseConfig,
      startAt,
      intervalMinutes: 45,
      now: new Date("2026-07-11T03:15:00Z"),
    });

    expect(next?.toISOString()).toBe("2026-07-11T10:10:00.000Z");
    expect(((next!.getTime() - startAt.getTime()) / 60_000) % 45).toBe(0);
  });

  it("handles spring-forward without crashing", () => {
    const next = nextPermittedCaptureTime({
      timeZone: "America/New_York",
      captureWindowEnabled: true,
      captureWindowStartMinutes: 2 * 60,
      captureWindowEndMinutes: 4 * 60,
      startAt: new Date("2026-03-08T06:30:00Z"),
      intervalMinutes: 30,
      now: new Date("2026-03-08T06:45:00Z"),
    });

    expect(next?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("skips duplicate wall-clock minutes during DST fallback", () => {
    const next = nextPermittedCaptureTime({
      timeZone: "America/New_York",
      captureWindowEnabled: true,
      captureWindowStartMinutes: 60,
      captureWindowEndMinutes: 2 * 60,
      startAt: new Date("2026-11-01T05:00:00Z"),
      intervalMinutes: 30,
      now: new Date("2026-11-01T05:31:00Z"),
    });

    expect(next?.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  it("groups photos by project-local date", () => {
    const photos = [{ id: "late", timestamp: new Date("2026-07-11T03:30:00Z") }];
    expect(dayKey(photos[0].timestamp, "America/New_York")).toBe("2026-07-10");
    expect(groupPhotosByDay(photos, "America/New_York")[0].key).toBe("2026-07-10");
    const range = localDayRange("2026-07-10", "America/New_York");
    expect(range.start.toISOString()).toBe("2026-07-10T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-07-11T04:00:00.000Z");
  });
});
