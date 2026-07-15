import type { Prisma, PrismaClient } from "@prisma/client";
import { PROJECT_SENSOR_ROLES } from "../projectSensorRoles";
import { activeSensorWhere, sensorDisplayName } from "./sensorConfig";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/projectSensors.ts is server-only operational code.");
}

export { PROJECT_SENSOR_ROLES };

const BINDING_INCLUDE = {
  node: true,
  sensor: true,
} satisfies Prisma.ProjectSensorBindingInclude;

export type ProjectSensorBindingPayload = ReturnType<typeof serializeProjectSensorBinding>;

export function normalizeProjectSensorRole(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return "ambient";
  const role = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(role)) throw new Error("role must be a short slug.");
  return role;
}

export function serializeProjectSensorBinding(
  binding: Prisma.ProjectSensorBindingGetPayload<{ include: typeof BINDING_INCLUDE }>,
) {
  const degraded = !binding.sensor.enabled || !binding.sensor.configuredActive || Boolean(binding.sensor.retiredAt);
  return {
    id: binding.id,
    projectId: binding.projectId,
    enabled: binding.enabled,
    label: binding.label,
    role: binding.role,
    linkedAt: binding.linkedAt.toISOString(),
    unlinkedAt: binding.unlinkedAt?.toISOString() ?? null,
    degraded,
    node: { id: binding.node.id, name: binding.node.name, role: binding.node.role },
    sensor: {
      id: binding.sensor.id,
      key: binding.sensor.key,
      name: sensorDisplayName(binding.sensor),
      displayName: binding.sensor.displayName,
      reportedName: binding.sensor.reportedName,
      type: binding.sensor.type,
      placement: binding.sensor.placement,
      configuredActive: binding.sensor.configuredActive,
      enabled: binding.sensor.enabled,
      retiredAt: binding.sensor.retiredAt?.toISOString() ?? null,
      lastAttemptAt: binding.sensor.lastAttemptAt?.toISOString() ?? null,
      lastAcceptedAt: binding.sensor.lastAcceptedAt?.toISOString() ?? null,
      latestClassification: binding.sensor.latestClassification,
      latestTemperatureC: binding.sensor.latestTemperatureC,
      latestHumidityPct: binding.sensor.latestHumidityPct,
    },
  };
}

export type AvailableProjectSensor = ReturnType<typeof serializeAvailableProjectSensor>;

function serializeAvailableProjectSensor(sensor: Prisma.NodeSensorGetPayload<{ include: { node: true } }>) {
  return {
    id: sensor.id,
    key: sensor.key,
    name: sensorDisplayName(sensor),
    displayName: sensor.displayName,
    reportedName: sensor.reportedName,
    type: sensor.type,
    placement: sensor.placement,
    node: { id: sensor.node.id, name: sensor.node.name, role: sensor.node.role },
  };
}

/**
 * Sensors eligible to link to a project: applied and configured-active only
 * (same definition as activeSensorWhere/activeSensorsForNode in
 * sensorConfig.ts - the node config control plane's single source of truth
 * for "currently configured"), across every registered node. Retired and
 * historical sensors are never offered here; they remain linkable only via
 * allowHistorical repair, not this picker.
 */
export async function listAvailableProjectSensors(prisma: PrismaClient): Promise<AvailableProjectSensor[]> {
  const nodes = await prisma.plantLabNode.findMany({
    where: { sensors: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const perNode = await Promise.all(
    nodes.map(async (node) => {
      const where = await activeSensorWhere(prisma, node.id);
      return prisma.nodeSensor.findMany({ where, include: { node: true }, orderBy: [{ placement: "asc" }, { key: "asc" }] });
    }),
  );

  return perNode.flat().map(serializeAvailableProjectSensor);
}

export async function listProjectSensorBindings(prisma: PrismaClient, projectId: string, options: { includeDisabled?: boolean } = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new Error("Project not found.");
  const bindings = await prisma.projectSensorBinding.findMany({
    where: {
      projectId,
      ...(options.includeDisabled ? {} : { enabled: true, unlinkedAt: null }),
    },
    include: BINDING_INCLUDE,
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
  });
  return bindings.map(serializeProjectSensorBinding);
}

export async function linkProjectSensor(
  prisma: PrismaClient,
  input: { projectId: string; sensorId: string; label?: string | null; role?: string | null; allowHistorical?: boolean },
) {
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
  if (!project) throw new Error("Project not found.");

  const sensor = await prisma.nodeSensor.findUnique({ where: { id: input.sensorId }, include: { node: true } });
  if (!sensor) throw new Error("sensorId does not reference an existing sensor.");
  const degraded = !sensor.enabled || !sensor.configuredActive || Boolean(sensor.retiredAt);
  if (degraded && !input.allowHistorical) {
    throw new Error("Sensor is not in the applied active configuration. Pass allowHistorical only for explicit historical binding repair.");
  }

  const existing = await prisma.projectSensorBinding.findFirst({
    where: { projectId: input.projectId, sensorId: input.sensorId, enabled: true, unlinkedAt: null },
    include: BINDING_INCLUDE,
  });
  if (existing) return serializeProjectSensorBinding(existing);

  const binding = await prisma.projectSensorBinding.create({
    data: {
      projectId: input.projectId,
      nodeId: sensor.nodeId,
      sensorId: sensor.id,
      label: normalizeOptionalLabel(input.label),
      role: normalizeProjectSensorRole(input.role),
    },
    include: BINDING_INCLUDE,
  });
  return serializeProjectSensorBinding(binding);
}

export async function updateProjectSensorBinding(
  prisma: PrismaClient,
  input: { projectId: string; bindingId: string; label?: string | null; role?: string | null; enabled?: boolean },
) {
  const existing = await prisma.projectSensorBinding.findFirst({ where: { id: input.bindingId, projectId: input.projectId } });
  if (!existing) throw new Error("Project sensor binding not found.");
  const binding = await prisma.projectSensorBinding.update({
    where: { id: existing.id },
    data: {
      label: input.label === undefined ? undefined : normalizeOptionalLabel(input.label),
      role: input.role === undefined ? undefined : normalizeProjectSensorRole(input.role),
      enabled: input.enabled,
      unlinkedAt: input.enabled === true ? null : input.enabled === false ? new Date() : undefined,
    },
    include: BINDING_INCLUDE,
  });
  return serializeProjectSensorBinding(binding);
}

export async function unlinkProjectSensor(prisma: PrismaClient, input: { projectId: string; bindingId: string }) {
  return updateProjectSensorBinding(prisma, { ...input, enabled: false });
}

export async function nearestPhotoEnvironment(
  prisma: PrismaClient,
  input: { projectId: string; photoId: string; maxDistanceMs?: number },
) {
  const maxDistanceMs = input.maxDistanceMs ?? 10 * 60_000;
  if (!Number.isFinite(maxDistanceMs) || maxDistanceMs <= 0 || maxDistanceMs > 60 * 60_000) {
    throw new Error("maxDistanceMs must be between 1 millisecond and 1 hour.");
  }
  const photo = await prisma.photo.findFirst({ where: { id: input.photoId, projectId: input.projectId } });
  if (!photo) throw new Error("Project photo not found.");

  const bindings = await prisma.projectSensorBinding.findMany({
    where: { projectId: input.projectId, enabled: true, unlinkedAt: null },
    include: BINDING_INCLUDE,
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
  });
  const from = new Date(photo.timestamp.getTime() - maxDistanceMs);
  const to = new Date(photo.timestamp.getTime() + maxDistanceMs);

  const readings = await prisma.sensorReading.findMany({
    where: { sensorId: { in: bindings.map((binding) => binding.sensorId) }, capturedAt: { gte: from, lte: to } },
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
  });

  const bySensor = new Map<string, typeof readings[number]>();
  for (const reading of readings) {
    const previous = bySensor.get(reading.sensorId);
    if (!previous || Math.abs(reading.capturedAt.getTime() - photo.timestamp.getTime()) < Math.abs(previous.capturedAt.getTime() - photo.timestamp.getTime())) {
      bySensor.set(reading.sensorId, reading);
    }
  }

  return {
    projectId: input.projectId,
    photo: { id: photo.id, timestamp: photo.timestamp.toISOString() },
    maxDistanceMs,
    readings: bindings.map((binding) => {
      const reading = bySensor.get(binding.sensorId);
      return {
        binding: serializeProjectSensorBinding(binding),
        reading: reading
          ? {
              id: reading.id,
              at: reading.capturedAt.toISOString(),
              distanceMs: Math.abs(reading.capturedAt.getTime() - photo.timestamp.getTime()),
              temperatureC: reading.temperatureC,
              humidityPct: reading.humidityPct,
            }
          : null,
      };
    }),
  };
}

function normalizeOptionalLabel(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
