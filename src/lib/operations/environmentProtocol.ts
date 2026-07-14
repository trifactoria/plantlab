import type { PrismaClient } from "@prisma/client";
import { activeSensorsForNode } from "./sensorConfig";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/environmentProtocol.ts is server-only operational code.");
}

export const ENVIRONMENT_CLASSIFICATIONS = ["accepted", "suspect", "rejected", "failed", "stale", "driver-unavailable"] as const;
export type EnvironmentClassification = (typeof ENVIRONMENT_CLASSIFICATIONS)[number];

export const ENVIRONMENT_LIMITS = {
  batchMaxEvents: 100,
  stringMaxLength: 200,
  diagnosticMessageMaxLength: 500,
  hardTemperatureC: { min: -40, max: 80 },
  hardHumidityPct: { min: 0, max: 100 },
  maxFutureMs: 5 * 60_000,
  maxPastMs: 180 * 24 * 60 * 60_000,
} as const;

export type EnvironmentSensorMetadata = {
  key: string;
  name: string;
  type: string;
  gpio: number | null;
  placement: string | null;
  enabled: boolean;
};

export type EnvironmentTelemetryEvent = {
  eventId: string;
  sensor: EnvironmentSensorMetadata;
  capturedAt: Date;
  classification: EnvironmentClassification;
  temperatureC: number | null;
  humidityPct: number | null;
  diagnosticCode: string | null;
  diagnosticMessage: string | null;
};

export type EnvironmentIngestResult = {
  acceptedEventIds: string[];
  duplicateEventIds: string[];
  storedReadings: number;
  storedDiagnostics: number;
};

export function isEnvironmentClassification(value: unknown): value is EnvironmentClassification {
  return typeof value === "string" && (ENVIRONMENT_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function parseEnvironmentBatch(raw: unknown, now = new Date()): EnvironmentTelemetryEvent[] {
  if (!isRecord(raw)) throw new Error("Request body must be a JSON object.");
  if (!Array.isArray(raw.events)) throw new Error("events must be an array.");
  if (raw.events.length > ENVIRONMENT_LIMITS.batchMaxEvents) {
    throw new Error(`events must contain at most ${ENVIRONMENT_LIMITS.batchMaxEvents} entries.`);
  }
  return raw.events.map((event, index) => parseEnvironmentEvent(event, index, now));
}

export async function ingestEnvironmentTelemetry(
  prisma: PrismaClient,
  nodeId: string,
  events: EnvironmentTelemetryEvent[],
): Promise<EnvironmentIngestResult> {
  if (events.length === 0) {
    return { acceptedEventIds: [], duplicateEventIds: [], storedReadings: 0, storedDiagnostics: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    let storedReadings = 0;
    let storedDiagnostics = 0;

    for (const event of events) {
      const existingReading = await tx.sensorReading.findUnique({ where: { nodeId_eventId: { nodeId, eventId: event.eventId } }, select: { id: true } });
      const existingDiagnostic = existingReading
        ? null
        : await tx.sensorDiagnostic.findUnique({ where: { nodeId_eventId: { nodeId, eventId: event.eventId } }, select: { id: true } });
      if (existingReading || existingDiagnostic) {
        duplicateEventIds.push(event.eventId);
        acceptedEventIds.push(event.eventId);
        continue;
      }

      const sensor = await tx.nodeSensor.upsert({
        where: { nodeId_key: { nodeId, key: event.sensor.key } },
        create: {
          nodeId,
          key: event.sensor.key,
          name: event.sensor.name,
          type: event.sensor.type,
          gpio: event.sensor.gpio,
          placement: event.sensor.placement,
          enabled: event.sensor.enabled,
          lastSeenAt: new Date(),
          ...statusCreateForEvent(event),
        },
        update: {
          name: event.sensor.name,
          type: event.sensor.type,
          gpio: event.sensor.gpio,
          placement: event.sensor.placement,
          enabled: event.sensor.enabled,
          lastSeenAt: new Date(),
          ...statusUpdateForEvent(event),
        },
      });

      if (event.classification === "accepted") {
        await tx.sensorReading.create({
          data: {
            sensorId: sensor.id,
            nodeId,
            eventId: event.eventId,
            capturedAt: event.capturedAt,
            temperatureC: event.temperatureC!,
            humidityPct: event.humidityPct!,
          },
        });
        storedReadings += 1;
      } else {
        await tx.sensorDiagnostic.create({
          data: {
            sensorId: sensor.id,
            nodeId,
            eventId: event.eventId,
            capturedAt: event.capturedAt,
            classification: event.classification,
            temperatureC: event.temperatureC,
            humidityPct: event.humidityPct,
            code: event.diagnosticCode,
            message: event.diagnosticMessage,
            // GPIO as currently configured at ingest time - denormalized so
            // historical diagnostics stay accurate across reassignment.
            // attemptNumber/driver/durationMs are populated for
            // sensor-test-sourced diagnostics only (see
            // sensorTestProtocol.ts) - ordinary continuous telemetry
            // sampling doesn't have a retry-attempt concept and the edge
            // driver doesn't currently measure/report per-read duration.
            gpio: event.sensor.gpio,
          },
        });
        storedDiagnostics += 1;
      }
      acceptedEventIds.push(event.eventId);
    }

    return { acceptedEventIds, duplicateEventIds, storedReadings, storedDiagnostics };
  });
}

export async function getLatestEnvironmentStatus(prisma: PrismaClient, nodeName: string) {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
  });
  if (!node) return null;
  const sensors = await activeSensorsForNode(prisma, node.id);
  return {
    node: { id: node.id, name: node.name, role: node.role },
    sensors: sensors.map((sensor) => ({
      key: sensor.key,
      name: sensor.name,
      type: sensor.type,
      gpio: sensor.gpio,
      placement: sensor.placement,
      enabled: sensor.enabled,
      latestClassification: sensor.latestClassification,
      latestTemperatureC: sensor.latestTemperatureC,
      latestHumidityPct: sensor.latestHumidityPct,
      lastAttemptAt: sensor.lastAttemptAt?.toISOString() ?? null,
      lastAcceptedAt: sensor.lastAcceptedAt?.toISOString() ?? null,
      stale: sensor.latestClassification === "stale",
      consecutiveFailures: sensor.consecutiveFailures,
      consecutiveRejects: sensor.consecutiveRejects,
      lastDiagnosticCode: sensor.lastDiagnosticCode,
      lastDiagnosticMessage: sensor.lastDiagnosticMessage,
    })),
  };
}

export type SensorEventHistoryItem = {
  kind: "accepted" | "diagnostic";
  capturedAt: string;
  classification: string;
  temperatureC: number | null;
  humidityPct: number | null;
  code: string | null;
  message: string | null;
  attemptNumber: number | null;
  driver: string | null;
  gpio: number | null;
  durationMs: number | null;
};

/** Full detail for one sensor's page - see /nodes/[nodeName]/sensors/[sensorKey]. */
export async function getSensorDetail(prisma: PrismaClient, nodeName: string, sensorKey: string, historyLimit = 25) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName } });
  if (!node) return { ok: false as const, status: 404, error: `No registered node named "${nodeName}".` };

  const sensor = await prisma.nodeSensor.findUnique({ where: { nodeId_key: { nodeId: node.id, key: sensorKey } } });
  if (!sensor) return { ok: false as const, status: 404, error: `Sensor "${sensorKey}" is not known for node "${nodeName}".` };

  const [recentReadings, recentDiagnostics] = await Promise.all([
    prisma.sensorReading.findMany({ where: { sensorId: sensor.id }, orderBy: { capturedAt: "desc" }, take: historyLimit }),
    prisma.sensorDiagnostic.findMany({ where: { sensorId: sensor.id }, orderBy: { capturedAt: "desc" }, take: historyLimit }),
  ]);

  const events: SensorEventHistoryItem[] = [
    ...recentReadings.map((reading): SensorEventHistoryItem => ({
      kind: "accepted",
      capturedAt: reading.capturedAt.toISOString(),
      classification: "accepted",
      temperatureC: reading.temperatureC,
      humidityPct: reading.humidityPct,
      code: null,
      message: null,
      attemptNumber: null,
      driver: null,
      gpio: null,
      durationMs: null,
    })),
    ...recentDiagnostics.map((diagnostic): SensorEventHistoryItem => ({
      kind: "diagnostic",
      capturedAt: diagnostic.capturedAt.toISOString(),
      classification: diagnostic.classification,
      temperatureC: diagnostic.temperatureC,
      humidityPct: diagnostic.humidityPct,
      code: diagnostic.code,
      message: diagnostic.message,
      attemptNumber: diagnostic.attemptNumber,
      driver: diagnostic.driver,
      gpio: diagnostic.gpio,
      durationMs: diagnostic.durationMs,
    })),
  ]
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))
    .slice(0, historyLimit);

  return {
    ok: true as const,
    node: { id: node.id, name: node.name, role: node.role },
    sensor: {
      key: sensor.key,
      name: sensor.name,
      type: sensor.type,
      gpio: sensor.gpio,
      placement: sensor.placement,
      enabled: sensor.enabled,
      latestClassification: sensor.latestClassification,
      latestTemperatureC: sensor.latestTemperatureC,
      latestHumidityPct: sensor.latestHumidityPct,
      lastAttemptAt: sensor.lastAttemptAt?.toISOString() ?? null,
      lastAcceptedAt: sensor.lastAcceptedAt?.toISOString() ?? null,
      stale: sensor.latestClassification === "stale",
      consecutiveFailures: sensor.consecutiveFailures,
      consecutiveRejects: sensor.consecutiveRejects,
      lastDiagnosticCode: sensor.lastDiagnosticCode,
      lastDiagnosticMessage: sensor.lastDiagnosticMessage,
      firstSeenAt: sensor.firstSeenAt.toISOString(),
    },
    events,
  };
}

function parseEnvironmentEvent(raw: unknown, index: number, now: Date): EnvironmentTelemetryEvent {
  if (!isRecord(raw)) throw new Error(`events[${index}] must be an object.`);
  const eventId = requiredString(raw.eventId, `events[${index}].eventId`, 120);
  const sensor = parseSensorMetadata(raw.sensor, index);
  const capturedAt = parseTimestamp(raw.capturedAt, `events[${index}].capturedAt`, now);
  if (!isEnvironmentClassification(raw.classification)) {
    throw new Error(`events[${index}].classification must be one of ${ENVIRONMENT_CLASSIFICATIONS.join(", ")}.`);
  }
  const classification = raw.classification;
  const temperatureC = optionalNumber(raw.temperatureC, `events[${index}].temperatureC`);
  const humidityPct = optionalNumber(raw.humidityPct, `events[${index}].humidityPct`);
  const diagnosticCode = optionalString(raw.diagnosticCode, `events[${index}].diagnosticCode`, ENVIRONMENT_LIMITS.stringMaxLength);
  const diagnosticMessage = optionalString(raw.diagnosticMessage, `events[${index}].diagnosticMessage`, ENVIRONMENT_LIMITS.diagnosticMessageMaxLength);

  if (classification === "accepted" && (temperatureC === null || humidityPct === null)) {
    throw new Error(`events[${index}] accepted readings require temperatureC and humidityPct.`);
  }
  if (temperatureC !== null && !within(temperatureC, ENVIRONMENT_LIMITS.hardTemperatureC)) {
    throw new Error(`events[${index}].temperatureC is outside hard physical bounds.`);
  }
  if (humidityPct !== null && !within(humidityPct, ENVIRONMENT_LIMITS.hardHumidityPct)) {
    throw new Error(`events[${index}].humidityPct is outside hard physical bounds.`);
  }

  return { eventId, sensor, capturedAt, classification, temperatureC, humidityPct, diagnosticCode, diagnosticMessage };
}

function parseSensorMetadata(raw: unknown, index: number): EnvironmentSensorMetadata {
  if (!isRecord(raw)) throw new Error(`events[${index}].sensor must be an object.`);
  const key = requiredString(raw.key, `events[${index}].sensor.key`, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(`events[${index}].sensor.key must contain only letters, numbers, underscores, and hyphens.`);
  }
  const gpio = raw.gpio === undefined || raw.gpio === null ? null : raw.gpio;
  if (gpio !== null && (!Number.isInteger(gpio) || typeof gpio !== "number" || gpio < 0 || gpio > 27)) {
    throw new Error(`events[${index}].sensor.gpio must be a BCM GPIO number from 0 to 27.`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`events[${index}].sensor.enabled must be a boolean when present.`);
  }
  return {
    key,
    name: requiredString(raw.name, `events[${index}].sensor.name`, ENVIRONMENT_LIMITS.stringMaxLength),
    type: requiredString(raw.type, `events[${index}].sensor.type`, 50),
    gpio,
    placement: optionalString(raw.placement, `events[${index}].sensor.placement`, ENVIRONMENT_LIMITS.stringMaxLength),
    enabled: raw.enabled === undefined ? true : raw.enabled,
  };
}

function statusCreateForEvent(event: EnvironmentTelemetryEvent) {
  const isAccepted = event.classification === "accepted";
  return {
    lastAttemptAt: event.capturedAt,
    lastAcceptedAt: isAccepted ? event.capturedAt : undefined,
    latestClassification: event.classification,
    latestTemperatureC: event.temperatureC,
    latestHumidityPct: event.humidityPct,
    consecutiveFailures: event.classification === "failed" || event.classification === "driver-unavailable" ? 1 : 0,
    consecutiveRejects: event.classification === "rejected" ? 1 : 0,
    lastDiagnosticCode: isAccepted ? null : event.diagnosticCode,
    lastDiagnosticMessage: isAccepted ? null : event.diagnosticMessage,
  };
}

function statusUpdateForEvent(event: EnvironmentTelemetryEvent) {
  const isAccepted = event.classification === "accepted";
  const isFailure = event.classification === "failed" || event.classification === "driver-unavailable";
  const isReject = event.classification === "rejected";
  return {
    lastAttemptAt: event.capturedAt,
    lastAcceptedAt: isAccepted ? event.capturedAt : undefined,
    latestClassification: event.classification,
    latestTemperatureC: event.temperatureC,
    latestHumidityPct: event.humidityPct,
    consecutiveFailures: isAccepted ? 0 : isFailure ? { increment: 1 } : undefined,
    consecutiveRejects: isAccepted ? 0 : isReject ? { increment: 1 } : undefined,
    lastDiagnosticCode: isAccepted ? null : event.diagnosticCode,
    lastDiagnosticMessage: isAccepted ? null : event.diagnosticMessage,
  };
}

function parseTimestamp(value: unknown, label: string, now: Date): Date {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid ISO 8601 timestamp.`);
  const delta = parsed.getTime() - now.getTime();
  if (delta > ENVIRONMENT_LIMITS.maxFutureMs) throw new Error(`${label} is too far in the future.`);
  if (-delta > ENVIRONMENT_LIMITS.maxPastMs) throw new Error(`${label} is too old.`);
  return parsed;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  const parsed = optionalString(value, label, maxLength);
  if (!parsed) throw new Error(`${label} is required.`);
  return parsed;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function within(value: number, bounds: { min: number; max: number }): boolean {
  return value >= bounds.min && value <= bounds.max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
