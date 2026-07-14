import { describe, expect, it } from "vitest";
import {
  ACTIVE_GREENHOUSE_SENSORS,
  canOutletPulse,
  canOutletUsePermanentOn,
  celsiusToFahrenheit,
  filterActiveSensors,
  filterCurrentlyActiveSensors,
  formatAge,
  formatDaysOfWeek,
  orderOutlets,
  outletLabel,
  sensorStatusTone,
  summarizeEnvironment,
  type EnvironmentSensor,
} from "../../src/lib/greenhouseDisplay";

function sensor(key: string, overrides: Partial<EnvironmentSensor> = {}): EnvironmentSensor {
  return {
    key,
    latestClassification: "accepted",
    latestTemperatureC: 22,
    latestHumidityPct: 55,
    lastAttemptAt: "2026-07-14T12:00:00.000Z",
    lastAcceptedAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("filterActiveSensors", () => {
  it("returns exactly the four currently-configured sensors in a stable order", () => {
    const slots = filterActiveSensors([]);
    expect(slots.map((slot) => slot.key)).toEqual(ACTIVE_GREENHOUSE_SENSORS.map((s) => s.key));
  });

  it("excludes the obsolete historical greenhouse-ambient row even when the API still returns it", () => {
    const sensors = [
      sensor("greenhouse-outside"),
      sensor("greenhouse-ambient", { latestClassification: "stale" }),
    ];
    const slots = filterActiveSensors(sensors);
    expect(slots.some((slot) => slot.key === "greenhouse-ambient")).toBe(false);
    expect(slots.find((slot) => slot.key === "greenhouse-outside")?.sensor).not.toBeNull();
  });

  it("marks a currently-configured sensor with no data yet as null rather than dropping it", () => {
    const slots = filterActiveSensors([sensor("greenhouse-outside")]);
    const bottom = slots.find((slot) => slot.key === "greenhouse-bottom");
    expect(bottom?.sensor).toBeNull();
  });
});

describe("sensorStatusTone", () => {
  it("maps classifications to display tones", () => {
    expect(sensorStatusTone(sensor("k", { latestClassification: "accepted" }))).toBe("fresh");
    expect(sensorStatusTone(sensor("k", { latestClassification: "stale" }))).toBe("stale");
    expect(sensorStatusTone(sensor("k", { latestClassification: "rejected" }))).toBe("rejected");
    expect(sensorStatusTone(sensor("k", { latestClassification: "suspect" }))).toBe("rejected");
    expect(sensorStatusTone(sensor("k", { latestClassification: "failed" }))).toBe("failed");
    expect(sensorStatusTone(sensor("k", { latestClassification: "driver-unavailable" }))).toBe("unavailable");
  });

  it("treats a sensor with no attempt yet as unavailable rather than crashing on nulls", () => {
    expect(sensorStatusTone(null)).toBe("unavailable");
    expect(sensorStatusTone(sensor("k", { lastAttemptAt: null, latestClassification: null }))).toBe("unavailable");
  });
});

describe("celsiusToFahrenheit", () => {
  it("converts known reference points", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(20)).toBeCloseTo(68, 5);
  });
});

describe("summarizeEnvironment", () => {
  it("computes hottest/coolest/humidity extremes only from fresh, valid sensors", () => {
    const slots = filterActiveSensors([
      sensor("greenhouse-outside", { latestTemperatureC: 30, latestHumidityPct: 40 }),
      sensor("greenhouse-bottom", { latestTemperatureC: 20, latestHumidityPct: 70 }),
      sensor("greenhouse-middle", { latestClassification: "stale", latestTemperatureC: null, latestHumidityPct: null }),
      sensor("greenhouse-top", { latestClassification: "rejected" }),
    ]);

    const summary = summarizeEnvironment(slots);
    expect(summary.hottest?.label).toBe("Outside");
    expect(summary.coolest?.label).toBe("Bottom shelf");
    expect(summary.highestHumidity?.label).toBe("Bottom shelf");
    expect(summary.lowestHumidity?.label).toBe("Outside");
  });

  it("returns nulls rather than a fabricated reading when no sensor is fresh", () => {
    const slots = filterActiveSensors([sensor("greenhouse-outside", { latestClassification: "stale", latestTemperatureC: null, latestHumidityPct: null })]);
    const summary = summarizeEnvironment(slots);
    expect(summary.hottest).toBeNull();
    expect(summary.coolest).toBeNull();
    expect(summary.highestHumidity).toBeNull();
    expect(summary.lowestHumidity).toBeNull();
  });

  it("reports the most recent accepted reading as the overall latest update", () => {
    const slots = filterActiveSensors([
      sensor("greenhouse-outside", { lastAcceptedAt: "2026-07-14T10:00:00.000Z" }),
      sensor("greenhouse-bottom", { lastAcceptedAt: "2026-07-14T12:00:00.000Z" }),
    ]);
    expect(summarizeEnvironment(slots).latestUpdateAt).toBe("2026-07-14T12:00:00.000Z");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");

  it("formats never, just now, minutes, hours, and days", () => {
    expect(formatAge(null, now)).toBe("never");
    expect(formatAge("2026-07-14T11:59:30.000Z", now)).toBe("just now");
    expect(formatAge("2026-07-14T11:55:00.000Z", now)).toBe("5 min ago");
    expect(formatAge("2026-07-14T09:00:00.000Z", now)).toBe("3 hr ago");
    expect(formatAge("2026-07-12T12:00:00.000Z", now)).toBe("2 days ago");
  });
});

describe("formatDaysOfWeek", () => {
  it("labels every day and specific subsets", () => {
    expect(formatDaysOfWeek([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(formatDaysOfWeek([])).toBe("Never");
    expect(formatDaysOfWeek([1, 3, 5])).toBe("Mon, Wed, Fri");
  });
});

describe("filterCurrentlyActiveSensors", () => {
  it("excludes a retired sensor whose last attempt is far older than the node's most recent attempt", () => {
    const sensors = [
      { key: "greenhouse-outside", enabled: true, lastAttemptAt: "2026-07-14T12:00:00.000Z" },
      { key: "greenhouse-ambient", enabled: true, lastAttemptAt: "2026-01-01T00:00:00.000Z" },
    ];
    const active = filterCurrentlyActiveSensors(sensors);
    expect(active.map((sensor) => sensor.key)).toEqual(["greenhouse-outside"]);
  });

  it("excludes any sensor explicitly disabled", () => {
    const sensors = [
      { key: "a", enabled: true, lastAttemptAt: "2026-07-14T12:00:00.000Z" },
      { key: "b", enabled: false, lastAttemptAt: "2026-07-14T12:00:00.000Z" },
    ];
    expect(filterCurrentlyActiveSensors(sensors).map((sensor) => sensor.key)).toEqual(["a"]);
  });

  it("keeps sensors whose last attempts are all close together, even with no attempts yet", () => {
    const sensors = [
      { key: "a", enabled: true, lastAttemptAt: null },
      { key: "b", enabled: true, lastAttemptAt: null },
    ];
    expect(filterCurrentlyActiveSensors(sensors).map((sensor) => sensor.key)).toEqual(["a", "b"]);
  });
});

describe("outlet behavior display helpers", () => {
  it("labels known outlets by friendly name and falls back to the reported name for unknown keys", () => {
    expect(outletLabel({ key: "fans" })).toBe("Fans");
    expect(outletLabel({ key: "lights" })).toBe("Lights");
    expect(outletLabel({ key: "water" })).toBe("Water");
    expect(outletLabel({ key: "co2-injector", name: "CO2 Injector" })).toBe("CO2 Injector");
    expect(outletLabel({ key: "co2-injector" })).toBe("co2-injector");
  });

  it("orders known outlets fans/lights/water first, then any others alphabetically by key", () => {
    const outlets = [{ key: "water" }, { key: "co2-injector" }, { key: "lights" }, { key: "fans" }, { key: "aux-pump" }];
    expect(orderOutlets(outlets).map((outlet) => outlet.key)).toEqual(["fans", "lights", "water", "aux-pump", "co2-injector"]);
  });

  it("treats water identically to any other normal outlet - no special-cased safety meaning", () => {
    expect(canOutletUsePermanentOn("normal")).toBe(true);
    expect(canOutletPulse("normal")).toBe(false);
    expect(canOutletUsePermanentOn("pulse-only")).toBe(false);
    expect(canOutletPulse("pulse-only")).toBe(true);
  });
});
