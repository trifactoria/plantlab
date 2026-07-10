import { describe, expect, it } from "vitest";
import { nextAlignedCaptureTime } from "../../src/lib/schedule";

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
