import type { NodeSensor, Prisma, PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/sensorConfig.ts is server-only operational code.");
}

export type DesiredSensorEntry = {
  id?: string;
  key: string;
  name: string;
  type: string;
  gpio: number;
  placement: string | null;
  enabled: boolean;
  retired?: boolean;
};

export type SensorConfigApplyReport = {
  revision: number;
  status: "applied" | "rejected";
  entries?: DesiredSensorEntry[];
  rejectionReason?: string | null;
  lastKnownGoodRevision?: number | null;
};

const SUPPORTED_SENSOR_TYPES = new Set(["dht22"]);

export function parseSensorEntries(raw: string): DesiredSensorEntry[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Stored sensor config entries are malformed.");
  return parsed.map(parseEntry);
}

export function validateSensorEntries(entries: DesiredSensorEntry[]): DesiredSensorEntry[] {
  const normalized = entries.map(parseEntry);
  const keys = new Set<string>();
  const gpios = new Set<number>();
  for (const entry of normalized) {
    if (keys.has(entry.key)) throw new Error(`Duplicate sensor key "${entry.key}".`);
    keys.add(entry.key);
    if (!entry.retired && entry.enabled) {
      if (gpios.has(entry.gpio)) throw new Error(`Duplicate BCM GPIO assignment ${entry.gpio}.`);
      gpios.add(entry.gpio);
    }
    if (!SUPPORTED_SENSOR_TYPES.has(entry.type)) throw new Error(`Unsupported sensor type "${entry.type}".`);
  }
  return normalized;
}

export async function getSensorConfiguration(prisma: PrismaClient, nodeName: string) {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: {
      sensors: { orderBy: [{ placement: "asc" }, { key: "asc" }] },
      sensorConfigRevisions: { orderBy: { revision: "desc" }, take: 5 },
    },
  });
  if (!node) return null;
  return {
    node: {
      id: node.id,
      name: node.name,
      desiredRevision: node.desiredSensorConfigRevision,
      appliedRevision: node.appliedSensorConfigRevision,
      appliedStatus: node.appliedSensorConfigStatus,
      appliedError: node.appliedSensorConfigError,
      updatedAt: node.sensorConfigUpdatedAt?.toISOString() ?? null,
    },
    desired: node.sensorConfigRevisions[0]
      ? {
          revision: node.sensorConfigRevisions[0].revision,
          status: node.sensorConfigRevisions[0].applyStatus,
          requestedAt: node.sensorConfigRevisions[0].requestedAt.toISOString(),
          entries: parseSensorEntries(node.sensorConfigRevisions[0].entriesJson),
          rejectionReason: node.sensorConfigRevisions[0].rejectionReason,
        }
      : null,
    sensors: node.sensors.map(serializeSensor),
    recentRevisions: node.sensorConfigRevisions.map((revision) => ({
      id: revision.id,
      revision: revision.revision,
      applyStatus: revision.applyStatus,
      requestedAt: revision.requestedAt.toISOString(),
      appliedAt: revision.appliedAt?.toISOString() ?? null,
      rejectedAt: revision.rejectedAt?.toISOString() ?? null,
      rejectionReason: revision.rejectionReason,
    })),
  };
}

export async function createDesiredSensorConfigRevision(
  prisma: PrismaClient,
  nodeName: string,
  entries: DesiredSensorEntry[],
  options: { requestedBy?: string | null; source?: string | null } = {},
) {
  const normalized = validateSensorEntries(entries);
  return prisma.$transaction(async (tx) => {
    const node = await tx.plantLabNode.findUniqueOrThrow({ where: { name: nodeName } });
    const latest = await tx.nodeSensorConfigRevision.findFirst({ where: { nodeId: node.id }, orderBy: { revision: "desc" } });
    const revision = (latest?.revision ?? 0) + 1;
    const created = await tx.nodeSensorConfigRevision.create({
      data: {
        nodeId: node.id,
        revision,
        requestedBy: options.requestedBy ?? null,
        source: options.source ?? "coordinator",
        validationStatus: "valid",
        applyStatus: "pending",
        entriesJson: JSON.stringify(normalized),
      },
    });
    await tx.plantLabNode.update({
      where: { id: node.id },
      data: {
        desiredSensorConfigRevision: revision,
        appliedSensorConfigStatus: "pending",
        appliedSensorConfigError: null,
        sensorConfigUpdatedAt: new Date(),
      },
    });
    await syncDesiredSensorRows(tx, node.id, revision, normalized);
    return created;
  });
}

export async function mutateSensorConfiguration(
  prisma: PrismaClient,
  nodeName: string,
  mutation: { op: "add"; entry: DesiredSensorEntry } | { op: "rename" | "gpio" | "placement" | "enable" | "disable" | "retire" | "restore"; sensorKey: string; value?: unknown },
  options: { requestedBy?: string | null } = {},
) {
  const current = await desiredEntriesOrCurrentSensors(prisma, nodeName);
  let next = current.map((entry) => ({ ...entry }));
  if (mutation.op === "add") {
    next.push(mutation.entry);
  } else {
    const index = next.findIndex((entry) => entry.key === mutation.sensorKey);
    if (index < 0) throw new Error(`Sensor "${mutation.sensorKey}" is not known for node "${nodeName}".`);
    const entry = { ...next[index] };
    if (mutation.op === "rename") entry.name = requiredString(mutation.value, "name");
    if (mutation.op === "gpio") entry.gpio = requiredGpio(mutation.value);
    if (mutation.op === "placement") entry.placement = optionalString(mutation.value);
    if (mutation.op === "enable") entry.enabled = true;
    if (mutation.op === "disable") entry.enabled = false;
    if (mutation.op === "retire") {
      entry.enabled = false;
      entry.retired = true;
    }
    if (mutation.op === "restore") {
      entry.enabled = true;
      entry.retired = false;
    }
    next[index] = entry;
  }
  return createDesiredSensorConfigRevision(prisma, nodeName, next, options);
}

export async function desiredSensorConfigForAgent(prisma: PrismaClient, nodeId: string) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: nodeId } });
  if (node.desiredSensorConfigRevision === null) return null;
  const revision = await prisma.nodeSensorConfigRevision.findUnique({
    where: { nodeId_revision: { nodeId, revision: node.desiredSensorConfigRevision } },
  });
  if (!revision) return null;
  return {
    revision: revision.revision,
    entries: parseSensorEntries(revision.entriesJson).filter((entry) => !entry.retired),
    applyStatus: revision.applyStatus,
  };
}

export async function reportAppliedSensorConfig(prisma: PrismaClient, nodeId: string, report: SensorConfigApplyReport) {
  const now = new Date();
  const revision = await prisma.nodeSensorConfigRevision.findUnique({
    where: { nodeId_revision: { nodeId, revision: report.revision } },
  });
  if (!revision) throw new Error(`Unknown desired sensor config revision ${report.revision}.`);
  const entries = report.entries ? validateSensorEntries(report.entries) : parseSensorEntries(revision.entriesJson);
  return prisma.$transaction(async (tx) => {
    if (report.status === "applied") {
      await tx.nodeSensorConfigRevision.update({
        where: { id: revision.id },
        data: { applyStatus: "applied", appliedAt: now, rejectedAt: null, rejectionReason: null },
      });
      await tx.plantLabNode.update({
        where: { id: nodeId },
        data: {
          appliedSensorConfigRevision: report.revision,
          appliedSensorConfigStatus: "applied",
          appliedSensorConfigError: null,
          sensorConfigUpdatedAt: now,
        },
      });
      await syncAppliedSensorRows(tx, nodeId, report.revision, entries);
      return { status: "ok", applied: true };
    }

    const reason = (report.rejectionReason ?? "Edge rejected desired sensor configuration.").slice(0, 1000);
    await tx.nodeSensorConfigRevision.update({
      where: { id: revision.id },
      data: { applyStatus: "rejected", rejectedAt: now, rejectionReason: reason },
    });
    await tx.plantLabNode.update({
      where: { id: nodeId },
      data: {
        appliedSensorConfigRevision: report.lastKnownGoodRevision ?? undefined,
        appliedSensorConfigStatus: "rejected",
        appliedSensorConfigError: reason,
        sensorConfigUpdatedAt: now,
      },
    });
    return { status: "ok", applied: false };
  });
}

export async function activeSensorWhere(prisma: PrismaClient, nodeId: string): Promise<Prisma.NodeSensorWhereInput> {
  const node = await prisma.plantLabNode.findUnique({ where: { id: nodeId }, select: { appliedSensorConfigRevision: true } });
  if (node?.appliedSensorConfigRevision !== null && node?.appliedSensorConfigRevision !== undefined) {
    return { nodeId, configuredActive: true, enabled: true, retiredAt: null, appliedConfigRevision: node.appliedSensorConfigRevision };
  }
  return compatibilityActiveSensorWhere(prisma, nodeId);
}

export async function activeSensorsForNode(prisma: PrismaClient, nodeId: string) {
  const where = await activeSensorWhere(prisma, nodeId);
  return prisma.nodeSensor.findMany({ where, orderBy: [{ placement: "asc" }, { key: "asc" }] });
}

async function compatibilityActiveSensorWhere(prisma: PrismaClient, nodeId: string): Promise<Prisma.NodeSensorWhereInput> {
  const sensors = await prisma.nodeSensor.findMany({ where: { nodeId, enabled: true }, select: { id: true, lastAttemptAt: true } });
  const mostRecentAttempt = Math.max(0, ...sensors.map((sensor) => sensor.lastAttemptAt?.getTime() ?? 0));
  const activeSince = mostRecentAttempt ? new Date(mostRecentAttempt - 60 * 60_000) : new Date(0);
  return { nodeId, enabled: true, retiredAt: null, lastAttemptAt: { gte: activeSince } };
}

async function desiredEntriesOrCurrentSensors(prisma: PrismaClient, nodeName: string): Promise<DesiredSensorEntry[]> {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: { sensors: { orderBy: [{ placement: "asc" }, { key: "asc" }] }, sensorConfigRevisions: { orderBy: { revision: "desc" }, take: 1 } },
  });
  if (!node) throw new Error(`No registered node named "${nodeName}".`);
  const latest = node.sensorConfigRevisions[0];
  if (latest) return parseSensorEntries(latest.entriesJson);
  return node.sensors.map(sensorToEntry);
}

async function syncDesiredSensorRows(tx: Prisma.TransactionClient, nodeId: string, revision: number, entries: DesiredSensorEntry[]) {
  for (const entry of entries) {
    await tx.nodeSensor.upsert({
      where: { nodeId_key: { nodeId, key: entry.key } },
      create: {
        nodeId,
        key: entry.key,
        name: entry.name,
        type: entry.type,
        gpio: entry.gpio,
        placement: entry.placement,
        enabled: entry.enabled,
        configuredActive: entry.enabled && !entry.retired,
        retiredAt: entry.retired ? new Date() : null,
        desiredConfigRevision: revision,
      },
      update: {
        name: entry.name,
        type: entry.type,
        gpio: entry.gpio,
        placement: entry.placement,
        enabled: entry.enabled,
        configuredActive: entry.enabled && !entry.retired,
        retiredAt: entry.retired ? new Date() : null,
        desiredConfigRevision: revision,
      },
    });
  }
}

async function syncAppliedSensorRows(tx: Prisma.TransactionClient, nodeId: string, revision: number, entries: DesiredSensorEntry[]) {
  const activeKeys = new Set(entries.filter((entry) => entry.enabled && !entry.retired).map((entry) => entry.key));
  for (const entry of entries) {
    await tx.nodeSensor.upsert({
      where: { nodeId_key: { nodeId, key: entry.key } },
      create: {
        nodeId,
        key: entry.key,
        name: entry.name,
        type: entry.type,
        gpio: entry.gpio,
        placement: entry.placement,
        enabled: entry.enabled,
        configuredActive: activeKeys.has(entry.key),
        retiredAt: entry.retired ? new Date() : null,
        desiredConfigRevision: revision,
        appliedConfigRevision: revision,
      },
      update: {
        name: entry.name,
        type: entry.type,
        gpio: entry.gpio,
        placement: entry.placement,
        enabled: entry.enabled,
        configuredActive: activeKeys.has(entry.key),
        retiredAt: entry.retired ? new Date() : null,
        appliedConfigRevision: revision,
      },
    });
  }
  await tx.nodeSensor.updateMany({
    where: { nodeId, key: { notIn: Array.from(activeKeys) }, appliedConfigRevision: { not: revision } },
    data: { configuredActive: false },
  });
}

function sensorToEntry(sensor: NodeSensor): DesiredSensorEntry {
  return {
    id: sensor.id,
    key: sensor.key,
    name: sensor.name,
    type: sensor.type,
    gpio: sensor.gpio ?? 0,
    placement: sensor.placement,
    enabled: sensor.enabled,
    retired: Boolean(sensor.retiredAt),
  };
}

function serializeSensor(sensor: NodeSensor) {
  return {
    id: sensor.id,
    key: sensor.key,
    name: sensor.name,
    type: sensor.type,
    gpio: sensor.gpio,
    placement: sensor.placement,
    enabled: sensor.enabled,
    configuredActive: sensor.configuredActive,
    retiredAt: sensor.retiredAt?.toISOString() ?? null,
    desiredConfigRevision: sensor.desiredConfigRevision,
    appliedConfigRevision: sensor.appliedConfigRevision,
    latestClassification: sensor.latestClassification,
    lastAttemptAt: sensor.lastAttemptAt?.toISOString() ?? null,
    lastAcceptedAt: sensor.lastAcceptedAt?.toISOString() ?? null,
  };
}

function parseEntry(raw: unknown): DesiredSensorEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Sensor config entries must be objects.");
  const item = raw as Record<string, unknown>;
  return {
    id: typeof item.id === "string" ? item.id : undefined,
    key: requiredKey(item.key),
    name: requiredString(item.name, "name"),
    type: requiredString(item.type, "type"),
    gpio: requiredGpio(item.gpio),
    placement: optionalString(item.placement),
    enabled: item.enabled === undefined ? true : item.enabled === true,
    retired: item.retired === true,
  };
}

function requiredKey(value: unknown): string {
  const key = requiredString(value, "key");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) throw new Error("Sensor key must contain only letters, numbers, underscores, and hyphens.");
  return key;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Sensor ${label} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Sensor placement must be a string when present.");
  return value.trim() || null;
}

function requiredGpio(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 27) throw new Error("Sensor gpio must be a BCM GPIO number from 0 to 27.");
  return value;
}
