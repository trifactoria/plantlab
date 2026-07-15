/**
 * Pure, framework-free helpers for the sensor management UI draft/apply
 * flow. Kept out of the React component so the desired-config validation is
 * unit-testable without a DOM (see tests/unit/sensorManagement.test.ts).
 */

export const SENSOR_TYPES = ["dht22"];

export type DesiredEntry = {
  id?: string;
  key: string;
  name: string;
  type: string;
  gpio: number;
  placement: string | null;
  enabled: boolean;
  retired: boolean;
};

export type OriginalSensor = {
  key: string;
  gpio: number | null;
  appliedConfigRevision: number | null;
  lastAttemptAt: string | null;
};

export function validateDraft(draft: DesiredEntry[], originals: OriginalSensor[] = []): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const keys = new Set<string>();
  const gpioOwners = new Map<number, string>();

  for (const entry of draft) {
    if (!entry.key.trim()) errors.push("Every sensor needs a logical key.");
    if (keys.has(entry.key)) errors.push(`Duplicate sensor key "${entry.key}".`);
    keys.add(entry.key);
    if (!entry.name.trim()) errors.push(`Sensor "${entry.key}" needs a display name.`);
    if (!SENSOR_TYPES.includes(entry.type)) errors.push(`Sensor "${entry.key}" has an unsupported type "${entry.type}".`);
    if (!Number.isInteger(entry.gpio) || entry.gpio < 0 || entry.gpio > 27) errors.push(`Sensor "${entry.key}" needs a BCM GPIO from 0 to 27.`);
    if (!entry.retired && entry.enabled) {
      const owner = gpioOwners.get(entry.gpio);
      if (owner) errors.push(`GPIO ${entry.gpio} is assigned to both "${owner}" and "${entry.key}".`);
      gpioOwners.set(entry.gpio, entry.key);
    }
  }

  for (const entry of draft) {
    const original = originals.find((sensor) => sensor.key === entry.key);
    if (original && original.gpio !== null && original.gpio !== entry.gpio && (original.appliedConfigRevision !== null || original.lastAttemptAt)) {
      warnings.push(`"${entry.key}" GPIO is changing from ${original.gpio} to ${entry.gpio} - confirm the physical wiring moved.`);
    }
  }

  return { errors, warnings };
}
