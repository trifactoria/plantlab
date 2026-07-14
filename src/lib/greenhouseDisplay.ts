/**
 * Pure display/formatting helpers for the greenhouse environment panel.
 * Kept separate from the React component so freshness/obsolete-sensor
 * filtering, unit conversion, and summary math are unit-testable without a
 * DOM (this repo has no React component test harness - see tests/unit/).
 */

export type EnvironmentSensor = {
  key: string;
  /** Always present from the environment API - optional here only so existing minimal test fixtures stay valid. */
  name?: string;
  enabled?: boolean;
  latestClassification: string | null;
  latestTemperatureC: number | null;
  latestHumidityPct: number | null;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  lastDiagnosticCode?: string | null;
  lastDiagnosticMessage?: string | null;
};

/** Counts active sensors whose current classification is not "fresh" - drives the home dashboard's "N sensors need attention" indicator. */
export function countSensorsNeedingAttention<T extends { key: string }>(slots: ActiveSensorSlot<T & EnvironmentSensor>[]): number {
  return slots.filter(({ sensor }) => sensorStatusTone(sensor) !== "fresh").length;
}

/**
 * The four currently-configured DHT22 sensors on greenhouse-zero, in
 * display order. Any other sensor key returned by the environment API
 * (e.g. the obsolete "greenhouse-ambient" row) is historical and must not
 * appear as one of these cards - its database rows are left untouched.
 */
export const ACTIVE_GREENHOUSE_SENSORS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "greenhouse-outside", label: "Outside" },
  { key: "greenhouse-bottom", label: "Bottom shelf" },
  { key: "greenhouse-middle", label: "Middle shelf" },
  { key: "greenhouse-top", label: "Top shelf" },
];

export type ActiveSensorSlot<T extends { key: string }> = { key: string; label: string; sensor: T | null };

export function filterActiveSensors<T extends { key: string }>(sensors: T[]): ActiveSensorSlot<T>[] {
  return ACTIVE_GREENHOUSE_SENSORS.map(({ key, label }) => ({
    key,
    label,
    sensor: sensors.find((candidate) => candidate.key === key) ?? null,
  }));
}

export type SensorStatusTone = "fresh" | "stale" | "rejected" | "failed" | "unavailable";

export const SENSOR_STATUS_LABEL: Record<SensorStatusTone, string> = {
  fresh: "Fresh",
  stale: "Stale",
  rejected: "Rejected",
  failed: "Failed",
  unavailable: "Unavailable",
};

export function sensorStatusTone(sensor: EnvironmentSensor | null): SensorStatusTone {
  if (!sensor || !sensor.lastAttemptAt) return "unavailable";
  switch (sensor.latestClassification) {
    case "accepted":
      return "fresh";
    case "stale":
      return "stale";
    case "rejected":
    case "suspect":
      return "rejected";
    case "failed":
      return "failed";
    case "driver-unavailable":
    default:
      return "unavailable";
  }
}

export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

const STILL_ACTIVE_WINDOW_MS = 60 * 60_000;

/**
 * Mirrors the "currently configured" heuristic in getNodeSummary()
 * (src/lib/operations/nodeDetail.ts): a sensor's own `enabled` flag never
 * clears just because the edge stops reporting it (e.g. a retired/renamed
 * sensor), so a sensor whose last attempt is more than an hour older than
 * the node's most recently attempted sensor is treated as no longer
 * actually configured, rather than a genuinely healthy or failed current
 * sensor. Keeps the sensors list page consistent with the node summary
 * card's counts. See docs/NODE_CONFIGURATION_CONTROL_PLANE.md - this is a
 * temporary display heuristic, not the long-term source of truth.
 */
export function filterCurrentlyActiveSensors<T extends { enabled?: boolean; lastAttemptAt: string | null }>(sensors: T[]): T[] {
  const attemptTimes = sensors.map((sensor) => (sensor.lastAttemptAt ? new Date(sensor.lastAttemptAt).getTime() : 0));
  const mostRecentAttempt = attemptTimes.length > 0 ? Math.max(...attemptTimes) : 0;
  return sensors.filter((sensor) => {
    if (sensor.enabled === false) return false;
    const attemptedAt = sensor.lastAttemptAt ? new Date(sensor.lastAttemptAt).getTime() : 0;
    return attemptedAt >= mostRecentAttempt - STILL_ACTIVE_WINDOW_MS;
  });
}

export type EnvironmentSummary = {
  hottest: { label: string; fahrenheit: number } | null;
  coolest: { label: string; fahrenheit: number } | null;
  highestHumidity: { label: string; pct: number } | null;
  lowestHumidity: { label: string; pct: number } | null;
  latestUpdateAt: string | null;
};

/**
 * Only sensors currently classified "fresh" (accepted) with a numeric
 * reading contribute to hottest/coolest/humidity extremes - a stale or
 * rejected sensor's last number is not a current condition. This is a
 * simple min/max across up to four sensors, not a statistical average.
 */
export function summarizeEnvironment<T extends { key: string }>(
  slots: ActiveSensorSlot<T & EnvironmentSensor>[],
): EnvironmentSummary {
  let hottest: EnvironmentSummary["hottest"] = null;
  let coolest: EnvironmentSummary["coolest"] = null;
  let highestHumidity: EnvironmentSummary["highestHumidity"] = null;
  let lowestHumidity: EnvironmentSummary["lowestHumidity"] = null;
  let latestUpdateAt: string | null = null;

  for (const { label, sensor } of slots) {
    if (sensor?.lastAcceptedAt && (!latestUpdateAt || sensor.lastAcceptedAt > latestUpdateAt)) {
      latestUpdateAt = sensor.lastAcceptedAt;
    }

    if (!sensor || sensorStatusTone(sensor) !== "fresh" || sensor.latestTemperatureC === null || sensor.latestHumidityPct === null) {
      continue;
    }

    const fahrenheit = celsiusToFahrenheit(sensor.latestTemperatureC);
    const pct = sensor.latestHumidityPct;

    if (!hottest || fahrenheit > hottest.fahrenheit) hottest = { label, fahrenheit };
    if (!coolest || fahrenheit < coolest.fahrenheit) coolest = { label, fahrenheit };
    if (!highestHumidity || pct > highestHumidity.pct) highestHumidity = { label, pct };
    if (!lowestHumidity || pct < lowestHumidity.pct) lowestHumidity = { label, pct };
  }

  return { hottest, coolest, highestHumidity, lowestHumidity, latestUpdateAt };
}

export function formatAge(value: string | null, now: Date = new Date()): string {
  if (!value) return "never";
  const then = new Date(value).getTime();
  const diffMs = now.getTime() - then;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatDaysOfWeek(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  if (sorted.length === 0) return "Never";
  return sorted.map((day) => DAY_LABELS[day] ?? "?").join(", ");
}

/**
 * Mirrors src/lib/outletBehavior.ts's OutletBehavior union without importing
 * that module - it is server-only (throws if evaluated in a browser) and
 * this file is shared with client components.
 */
export type OutletBehaviorValue = "normal" | "pulse-only";

export function canOutletUsePermanentOn(behavior: OutletBehaviorValue): boolean {
  return behavior === "normal";
}

export function canOutletPulse(behavior: OutletBehaviorValue): boolean {
  return behavior === "pulse-only";
}

/** Friendly labels for the outlets known ahead of time - any other outlet key falls back to its own reported name. */
const KNOWN_OUTLET_LABELS: Record<string, string> = { fans: "Fans", lights: "Lights", water: "Water" };
/** Preferred display/menu order for the known outlet keys; anything else sorts after these, alphabetically by key. */
const KNOWN_OUTLET_ORDER = ["fans", "lights", "water"];

export function outletLabel(outlet: { key: string; name?: string | null }): string {
  return KNOWN_OUTLET_LABELS[outlet.key] ?? outlet.name ?? outlet.key;
}

/** Stable outlet ordering: known friendly-labeled outlets first (fans, lights, water), then any additional configured outlets alphabetically by key. */
export function orderOutlets<T extends { key: string }>(outlets: T[]): T[] {
  return [...outlets].sort((a, b) => {
    const aRank = KNOWN_OUTLET_ORDER.indexOf(a.key);
    const bRank = KNOWN_OUTLET_ORDER.indexOf(b.key);
    const aOrder = aRank === -1 ? KNOWN_OUTLET_ORDER.length : aRank;
    const bOrder = bRank === -1 ? KNOWN_OUTLET_ORDER.length : bRank;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.key.localeCompare(b.key);
  });
}
