import { isValidCapability, type NodeCapability } from "./capabilities";
import { DEFAULT_OUTLET_BEHAVIOR, normalizeOutletBehavior, type OutletBehavior } from "../outletBehavior";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/greenhouseConfig.ts is server-only operational code.");
}

export const GREENHOUSE_SENSOR_TYPES = ["dht22"] as const;
export type GreenhouseSensorType = (typeof GREENHOUSE_SENSOR_TYPES)[number];
export const GREENHOUSE_OUTLET_KEYS = ["fans", "water", "lights"] as const;
export type GreenhouseOutletKey = (typeof GREENHOUSE_OUTLET_KEYS)[number];

export type GreenhouseSensorConfig = {
  key: string;
  name: string;
  type: GreenhouseSensorType;
  gpio: number;
  placement?: string | null;
  enabled: boolean;
};

export type GreenhousePowerConfig = {
  provider: "kasa";
  host: string;
  outlets: Partial<Record<GreenhouseOutletKey, string>>;
  outletBehaviors?: Partial<Record<GreenhouseOutletKey, OutletBehavior>>;
};

export type GreenhouseConfigSummary = {
  sensors: GreenhouseSensorConfig[];
  power: GreenhousePowerConfig | null;
  capabilities: NodeCapability[];
  secretFileExists?: boolean;
  pythonReadiness?: PythonReadiness;
};

export type PythonReadiness = {
  status: "ready" | "not-ready" | "unknown";
  version: string | null;
  detail: string;
};

export type EdgeConfigMergeInput = {
  role: "camera-node" | "greenhouse-node";
  nodeName: string;
  coordinatorUrl: string;
  spoolRoot: string;
  cameraEnabled: boolean;
  sensors?: GreenhouseSensorConfig[] | null;
  power?: GreenhousePowerConfig | null;
  disableSensors?: boolean;
  disablePower?: boolean;
};

export type GreenhouseValidationResult = {
  ok: boolean;
  errors: string[];
};

export function parseGreenhouseSensors(raw: unknown): GreenhouseSensorConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("sensors must be an array.");
  }
  return raw.map((item, index) => parseGreenhouseSensor(item, index));
}

export function parseGreenhousePower(raw: unknown): GreenhousePowerConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new Error("power must be an object.");
  }
  if (raw.enabled === false) return null;
  const provider = stringValue(raw.provider);
  if (!provider) {
    throw new Error("power.provider is required when power is configured.");
  }
  if (provider !== "kasa") {
    throw new Error(`Unsupported power provider "${provider}". Supported providers: kasa.`);
  }
  const host = stringValue(raw.host);
  if (!host) {
    throw new Error("power.host is required when power provider is kasa.");
  }
  const outletsRaw = raw.outlets;
  if (outletsRaw !== undefined && !isRecord(outletsRaw)) {
    throw new Error("power.outlets must be an object.");
  }
  const outlets: Partial<Record<GreenhouseOutletKey, string>> = {};
  if (isRecord(outletsRaw)) {
    for (const [key, value] of Object.entries(outletsRaw)) {
      if (!isGreenhouseOutletKey(key)) {
        throw new Error(`Unsupported power outlet key "${key}". Supported keys: ${GREENHOUSE_OUTLET_KEYS.join(", ")}.`);
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`power.outlets.${key} must be a non-empty string when present.`);
      }
      outlets[key] = value.trim();
    }
  }
  const outletBehaviors = parseOutletBehaviors(raw.outletBehaviors, outlets);
  return { provider, host, outlets, outletBehaviors };
}

export function validateGreenhouseConfig(raw: Record<string, unknown>): GreenhouseValidationResult {
  const errors: string[] = [];
  try {
    validateSensorSet(parseGreenhouseSensors(raw.sensors));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    parseGreenhousePower(raw.power);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: errors.length === 0, errors };
}

export function deriveCapabilitiesFromEdgeConfig(raw: Record<string, unknown>): NodeCapability[] {
  const capabilities: NodeCapability[] = [];
  const current = Array.isArray(raw.capabilities) ? raw.capabilities.filter(isValidCapability) : [];
  if (current.includes("camera")) capabilities.push("camera");

  if (raw.role !== "greenhouse-node") {
    return uniqueCapabilities(capabilities);
  }

  let sensors: GreenhouseSensorConfig[] = [];
  let power: GreenhousePowerConfig | null = null;
  try {
    sensors = parseGreenhouseSensors(raw.sensors);
    validateSensorSet(sensors);
  } catch {
    sensors = [];
  }
  try {
    power = parseGreenhousePower(raw.power);
  } catch {
    power = null;
  }

  if (sensors.some((sensor) => sensor.enabled && sensor.type === "dht22")) {
    capabilities.push("temperature", "humidity");
  }
  if (power) {
    capabilities.push("relay");
    if (power.outlets.fans) capabilities.push("fan");
    if (power.outlets.lights) capabilities.push("light");
    if (power.outlets.water) capabilities.push("pump");
  }
  return uniqueCapabilities(capabilities);
}

export function mergeEdgeAgentConfig(existing: Record<string, unknown>, input: EdgeConfigMergeInput): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    role: input.role,
    nodeName: input.nodeName,
    coordinatorUrl: input.coordinatorUrl,
    spoolRoot: input.spoolRoot,
    heartbeatIntervalSeconds: intOrDefault(existing.heartbeatIntervalSeconds, 30),
    pollIntervalSeconds: intOrDefault(existing.pollIntervalSeconds, 5),
    sensorSampleIntervalSeconds: intOrDefault(existing.sensorSampleIntervalSeconds, 15),
    environmentUploadIntervalSeconds: intOrDefault(existing.environmentUploadIntervalSeconds, 45),
    maxSpoolBytes: intOrDefault(existing.maxSpoolBytes, 536870912),
    maxUploadBytes: intOrDefault(existing.maxUploadBytes, 8388608),
  };

  if (input.disableSensors) {
    delete next.sensors;
  } else if (input.sensors !== undefined && input.sensors !== null) {
    validateSensorSet(input.sensors);
    next.sensors = input.sensors.map((sensor) => ({
      key: sensor.key,
      name: sensor.name,
      type: sensor.type,
      gpio: sensor.gpio,
      placement: sensor.placement ?? null,
      enabled: sensor.enabled,
    }));
  }

  if (input.disablePower) {
    delete next.power;
  } else if (input.power !== undefined) {
    if (input.power === null) delete next.power;
    else next.power = { provider: input.power.provider, host: input.power.host, outlets: { ...input.power.outlets }, outletBehaviors: materializeOutletBehaviors(input.power.outlets, input.power.outletBehaviors) };
  } else if (isRecord(next.power)) {
    next.power = normalizePowerConfigForMerge(next.power);
  }

  next.capabilities = deriveCapabilitiesFromEdgeConfig({
    ...next,
    capabilities: input.cameraEnabled ? ["camera"] : [],
  });

  return next;
}

export function greenhouseConfigSummary(raw: Record<string, unknown>): GreenhouseConfigSummary {
  return {
    sensors: parseGreenhouseSensors(raw.sensors),
    power: parseGreenhousePower(raw.power),
    capabilities: deriveCapabilitiesFromEdgeConfig(raw),
  };
}

export function pythonKasaReadiness(version: string | null | undefined): PythonReadiness {
  if (!version) {
    return {
      status: "unknown",
      version: null,
      detail: "Remote Python version could not be detected.",
    };
  }
  const majorMinor = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!majorMinor) {
    return {
      status: "unknown",
      version,
      detail: `Remote Python detected: ${version}. Could not determine python-kasa readiness.`,
    };
  }
  const major = Number(majorMinor[1]);
  const minor = Number(majorMinor[2]);
  const ready = major > 3 || (major === 3 && minor >= 11);
  return {
    status: ready ? "ready" : "not-ready",
    version,
    detail: ready
      ? `Power control configured. Runtime Kasa support requires Python 3.11 or newer. Remote Python detected: ${version}.`
      : `Power control configured. Runtime Kasa support requires Python 3.11 or newer. Remote Python detected: ${version}.`,
  };
}

export function redactedGreenhouseSummary(raw: Record<string, unknown>, options: { secretFileExists?: boolean; pythonVersion?: string | null } = {}) {
  const summary = greenhouseConfigSummary(raw);
  return {
    role: typeof raw.role === "string" ? raw.role : null,
    nodeName: typeof raw.nodeName === "string" ? raw.nodeName : null,
    capabilities: summary.capabilities,
    sensors: summary.sensors.map((sensor) => ({
      key: sensor.key,
      name: sensor.name,
      type: sensor.type,
      gpio: sensor.gpio,
      placement: sensor.placement ?? null,
      enabled: sensor.enabled,
    })),
    power: summary.power
      ? {
          provider: summary.power.provider,
          host: summary.power.host,
          outlets: summary.power.outlets,
          outletBehaviors: summary.power.outletBehaviors,
        }
      : null,
    greenhouseSecretFileExists: options.secretFileExists,
    pythonKasaReadiness: summary.power ? pythonKasaReadiness(options.pythonVersion) : null,
  };
}

function parseGreenhouseSensor(raw: unknown, index: number): GreenhouseSensorConfig {
  if (!isRecord(raw)) {
    throw new Error(`sensors[${index}] must be an object.`);
  }
  const key = stringValue(raw.key);
  const name = stringValue(raw.name);
  const type = stringValue(raw.type);
  const gpio = raw.gpio;
  if (!key) throw new Error(`sensors[${index}].key is required.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(`sensors[${index}].key must contain only letters, numbers, underscores, and hyphens.`);
  }
  if (!name) throw new Error(`sensors[${index}].name is required.`);
  if (!isGreenhouseSensorType(type)) {
    throw new Error(`Unsupported sensor type "${type || "(missing)"}". Supported sensor types: ${GREENHOUSE_SENSOR_TYPES.join(", ")}.`);
  }
  if (!Number.isInteger(gpio) || typeof gpio !== "number" || gpio < 0 || gpio > 27) {
    throw new Error(`sensors[${index}].gpio must be a BCM GPIO number from 0 to 27.`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`sensors[${index}].enabled must be a boolean when present.`);
  }
  return {
    key,
    name,
    type,
    gpio,
    placement: raw.placement === undefined || raw.placement === null ? null : String(raw.placement).trim() || null,
    enabled: raw.enabled === undefined ? true : raw.enabled,
  };
}

function validateSensorSet(sensors: GreenhouseSensorConfig[]): void {
  const keys = new Set<string>();
  const gpios = new Set<number>();
  for (const sensor of sensors) {
    if (keys.has(sensor.key)) throw new Error(`Duplicate sensor key "${sensor.key}".`);
    keys.add(sensor.key);
    if (gpios.has(sensor.gpio)) throw new Error(`Duplicate BCM GPIO assignment ${sensor.gpio}.`);
    gpios.add(sensor.gpio);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isGreenhouseSensorType(value: string): value is GreenhouseSensorType {
  return (GREENHOUSE_SENSOR_TYPES as readonly string[]).includes(value);
}

function isGreenhouseOutletKey(value: string): value is GreenhouseOutletKey {
  return (GREENHOUSE_OUTLET_KEYS as readonly string[]).includes(value);
}

function parseOutletBehaviors(raw: unknown, outlets: Partial<Record<GreenhouseOutletKey, string>>): Partial<Record<GreenhouseOutletKey, OutletBehavior>> {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    throw new Error("power.outletBehaviors must be an object.");
  }
  const result: Partial<Record<GreenhouseOutletKey, OutletBehavior>> = {};
  for (const key of GREENHOUSE_OUTLET_KEYS) {
    if (!outlets[key]) continue;
    const value = isRecord(raw) ? raw[key] : undefined;
    if (value === undefined || value === null || value === "") {
      result[key] = DEFAULT_OUTLET_BEHAVIOR;
      continue;
    }
    const behavior = normalizeOutletBehavior(value);
    if (!behavior) {
      throw new Error(`power.outletBehaviors.${key} must be one of normal, pulse-only.`);
    }
    result[key] = behavior;
  }
  if (isRecord(raw)) {
    for (const key of Object.keys(raw)) {
      if (!isGreenhouseOutletKey(key)) {
        throw new Error(`Unsupported power outlet behavior key "${key}". Supported keys: ${GREENHOUSE_OUTLET_KEYS.join(", ")}.`);
      }
      if (!outlets[key]) {
        throw new Error(`power.outletBehaviors.${key} cannot be set because power.outlets.${key} is not configured.`);
      }
    }
  }
  return result;
}

function materializeOutletBehaviors(
  outlets: Partial<Record<GreenhouseOutletKey, string>>,
  configured: Partial<Record<GreenhouseOutletKey, OutletBehavior>> | undefined,
): Partial<Record<GreenhouseOutletKey, OutletBehavior>> {
  const result: Partial<Record<GreenhouseOutletKey, OutletBehavior>> = {};
  for (const key of GREENHOUSE_OUTLET_KEYS) {
    if (outlets[key]) result[key] = configured?.[key] ?? DEFAULT_OUTLET_BEHAVIOR;
  }
  return result;
}

function normalizePowerConfigForMerge(raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseGreenhousePower(raw);
  if (!parsed) return raw;
  return {
    ...raw,
    outletBehaviors: materializeOutletBehaviors(parsed.outlets, parsed.outletBehaviors),
  };
}

function uniqueCapabilities(values: NodeCapability[]): NodeCapability[] {
  return Array.from(new Set(values.filter(isValidCapability)));
}

function intOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
