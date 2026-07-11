import { describe, expect, it } from "vitest";
import { baselineForPlant, formatElapsed, gramsPerDay } from "../../src/lib/experiment";

describe("experiment helpers", () => {
  it("uses project plantedAt as the known biological baseline", () => {
    const baseline = baselineForPlant(
      { plantedAt: new Date("2026-07-01T12:00:00Z") },
      { startedAt: new Date("2026-07-02T12:00:00Z") },
    );
    expect(baseline.label).toBe("Project planting date");
    expect(baseline.date.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("falls back to plant startedAt when planting time is unknown", () => {
    const baseline = baselineForPlant(
      { plantedAt: null },
      { startedAt: new Date("2026-07-02T12:00:00Z") },
    );
    expect(baseline.label).toBe("Plant start date");
  });

  it("formats compact elapsed values", () => {
    expect(formatElapsed(18 * 60 * 60_000 + 22 * 60_000)).toBe("18h 22m");
    expect(formatElapsed(2 * 86_400_000 + 4 * 60 * 60_000)).toBe("2d 4h");
    expect(formatElapsed(24 * 86_400_000)).toBe("24d");
  });

  it("calculates grams per day from harvest weight and baseline", () => {
    const value = gramsPerDay({
      weightGrams: 20,
      baseline: new Date("2026-07-01T00:00:00Z"),
      harvestedAt: new Date("2026-07-11T00:00:00Z"),
    });
    expect(value).toBe(2);
  });
});
