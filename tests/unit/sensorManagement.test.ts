import { describe, expect, it } from "vitest";
import { validateDraft, type DesiredEntry } from "../../src/lib/sensorManagement";

function entry(overrides: Partial<DesiredEntry> = {}): DesiredEntry {
  return { key: "s1", name: "Sensor 1", type: "dht22", gpio: 4, placement: null, enabled: true, retired: false, ...overrides };
}

describe("sensor management draft validation", () => {
  it("accepts a valid draft", () => {
    const result = validateDraft([entry({ key: "a", gpio: 4 }), entry({ key: "b", gpio: 17 })]);
    expect(result.errors).toEqual([]);
  });

  it("rejects a duplicate logical key", () => {
    const result = validateDraft([entry({ key: "a", gpio: 4 }), entry({ key: "a", gpio: 17 })]);
    expect(result.errors.some((error) => /Duplicate sensor key/.test(error))).toBe(true);
  });

  it("rejects a duplicate GPIO among enabled, non-retired sensors", () => {
    const result = validateDraft([entry({ key: "a", gpio: 4 }), entry({ key: "b", gpio: 4 })]);
    expect(result.errors.some((error) => /GPIO 4 is assigned to both/.test(error))).toBe(true);
  });

  it("allows a duplicate GPIO when one of the sensors is retired or disabled", () => {
    const result = validateDraft([entry({ key: "a", gpio: 4 }), entry({ key: "b", gpio: 4, retired: true, enabled: false })]);
    expect(result.errors).toEqual([]);
  });

  it("rejects a GPIO outside the BCM range", () => {
    expect(validateDraft([entry({ gpio: 40 })]).errors.some((error) => /BCM GPIO from 0 to 27/.test(error))).toBe(true);
    expect(validateDraft([entry({ gpio: -1 })]).errors.some((error) => /BCM GPIO from 0 to 27/.test(error))).toBe(true);
  });

  it("rejects an unsupported sensor type", () => {
    expect(validateDraft([entry({ type: "bme280" })]).errors.some((error) => /unsupported type/.test(error))).toBe(true);
  });

  it("requires a display name", () => {
    expect(validateDraft([entry({ name: "  " })]).errors.some((error) => /needs a display name/.test(error))).toBe(true);
  });

  it("warns (but does not block) when changing GPIO on a sensor that has history", () => {
    const result = validateDraft([entry({ key: "a", gpio: 22 })], [{ key: "a", gpio: 4, appliedConfigRevision: 1, lastAttemptAt: "2026-07-14T12:00:00.000Z" }]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => /GPIO is changing from 4 to 22/.test(warning))).toBe(true);
  });

  it("does not warn about a GPIO change for a brand-new sensor with no history", () => {
    const result = validateDraft([entry({ key: "new", gpio: 22 })], []);
    expect(result.warnings).toEqual([]);
  });
});
