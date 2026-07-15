import os from "node:os";
import type { PrismaClient } from "@prisma/client";
import { canDiscoverLocalCameraHardware } from "../localOnly";
import { computeServiceHealth, getServiceStatusSnapshot } from "../serviceStatus";
import { computeNodeStatus, hasActiveCredential } from "./nodeCredentials";
import { parseCapabilities } from "./capabilities";
import { readNodeConfig } from "./config";
import { listFleetCameras, listFleetSensors, type FleetCameraSummary, type FleetSensorSummary } from "./fleetHardware";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/nodeSummary.ts is server-only operational code.");
}

export type NodeSummary = {
  id: string;
  name: string;
  displayName: string;
  relationship: "self" | "attached";
  mode: "coordinator" | "standalone" | "camera-node" | "greenhouse-node" | "mixed";
  role: string;
  online: boolean;
  status: "active" | "degraded" | "pending" | "offline";
  activity: { label: string; at: string | null; kind: "service" | "heartbeat" | "pending" };
  resources: {
    cameras: { count: number; active: number; unavailable: number; url: string };
    sensors: { count: number; active: number; degraded: number; url: string };
  };
  detailsUrl: string;
  activityUrl: string;
  systemUrl: string | null;
};

export type NodeSummaryResponse = {
  ordering: string;
  nodes: NodeSummary[];
};

export async function getNodeSummaries(prisma: PrismaClient, now = new Date()): Promise<NodeSummaryResponse> {
  const [config, service, fleetCameras, fleetSensors, dbNodes] = await Promise.all([
    readNodeConfig(),
    getServiceStatusSnapshot(prisma, now),
    listFleetCameras(prisma, { now }),
    listFleetSensors(prisma, { now }),
    prisma.plantLabNode.findMany({
      include: { credentials: { where: { revokedAt: null }, select: { id: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const selfName = config?.nodeName ?? config?.hostname ?? os.hostname();
  const selfRole = config?.role ?? "standalone";
  const dbSelf = dbNodes.find((node) => node.name === selfName) ?? null;
  const selfCapabilities = dbSelf ? parseCapabilities(dbSelf.capabilitiesJson) : config?.capabilities ?? [];
  const selfResources = resourcesForNode(selfName, fleetCameras, fleetSensors);
  if (!dbSelf) {
    selfResources.cameras.url = "/capture-sources";
    selfResources.sensors.url = "/";
  }
  const serviceHealth = computeServiceHealth(
    service.lastHeartbeat ? { lastHeartbeat: new Date(service.lastHeartbeat) } : null,
    now,
  );
  const selfStatus: NodeSummary["status"] = serviceHealth === "stale" ? "degraded" : resourceAwareStatus("active", selfResources);
  const selfRow: NodeSummary = {
    id: dbSelf?.id ?? `self:${selfName}`,
    name: selfName,
    displayName: selfName,
    relationship: "self",
    mode: normalizeNodeMode(selfRole, selfCapabilities),
    role: selfRole,
    online: true,
    status: selfStatus,
    activity: {
      label: serviceHealth === "stale" ? "Service heartbeat stale" : "Running",
      at: service.lastHeartbeat,
      kind: "service",
    },
    resources: selfResources,
    detailsUrl: dbSelf ? `/nodes/${encodeURIComponent(selfName)}` : "/",
    activityUrl: dbSelf ? `/nodes/${encodeURIComponent(selfName)}/activity` : "/support",
    systemUrl: "/support",
  };

  const attached = await Promise.all(
    dbNodes
      .filter((node) => node.name !== selfName)
      .map(async (node) => {
        const activeCredential = await hasActiveCredential(prisma, node.id);
        const statusLabel = computeNodeStatus(node, activeCredential, now);
        const capabilities = parseCapabilities(node.capabilitiesJson);
        const resources = resourcesForNode(node.name, fleetCameras, fleetSensors);
        const baseStatus: NodeSummary["status"] = statusLabel === "active" ? "active" : statusLabel === "pending" ? "pending" : "offline";
        const status = baseStatus === "active" ? resourceAwareStatus(baseStatus, resources) : baseStatus;
        return {
          id: node.id,
          name: node.name,
          displayName: node.hostname ?? node.name,
          relationship: "attached" as const,
          mode: normalizeNodeMode(node.role, capabilities),
          role: node.role,
          online: statusLabel === "active",
          status,
          activity: node.lastHeartbeatAt
            ? { label: "Heartbeat accepted", at: node.lastHeartbeatAt.toISOString(), kind: "heartbeat" as const }
            : { label: "Awaiting first heartbeat", at: null, kind: "pending" as const },
          resources,
          detailsUrl: `/nodes/${encodeURIComponent(node.name)}`,
          activityUrl: `/nodes/${encodeURIComponent(node.name)}/activity`,
          systemUrl: null,
        } satisfies NodeSummary;
      }),
  );

  attached.sort((a, b) => {
    const statusDelta = statusOrder(a.status) - statusOrder(b.status);
    if (statusDelta !== 0) return statusDelta;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    ordering: "self first, then attached nodes by active/degraded, pending, offline, then display name",
    nodes: [selfRow, ...attached],
  };
}

function resourcesForNode(nodeName: string, fleetCameras: FleetCameraSummary[], fleetSensors: FleetSensorSummary[]) {
  const visibleCameras = fleetCameras.filter(
    (camera) =>
      camera.node.name === nodeName &&
      !camera.retired &&
      (camera.available || camera.assignmentId !== null || camera.captureSourceId !== null || camera.node.localToCoordinator || canDiscoverLocalCameraHardware()),
  );
  const activeSensors = fleetSensors.filter((sensor) => sensor.node.name === nodeName && !sensor.retired && sensor.enabled && sensor.configuredActive);
  const activeCameras = visibleCameras.filter((camera) => camera.usableForCapture).length;
  const degradedSensors = activeSensors.filter((sensor) => sensor.health.state !== "healthy").length;
  return {
    cameras: {
      count: visibleCameras.length,
      active: activeCameras,
      unavailable: visibleCameras.length - activeCameras,
      url: nodeName ? `/nodes/${encodeURIComponent(nodeName)}/cameras` : "/capture-sources",
    },
    sensors: {
      count: activeSensors.length,
      active: activeSensors.length,
      degraded: degradedSensors,
      url: nodeName ? `/nodes/${encodeURIComponent(nodeName)}/sensors` : "/",
    },
  };
}

function normalizeNodeMode(role: string, capabilities: string[]): NodeSummary["mode"] {
  if (role === "coordinator" || role === "standalone" || role === "camera-node" || role === "greenhouse-node") return role;
  const hasCamera = capabilities.includes("camera");
  const hasEnvironment = capabilities.some((capability) => ["temperature", "humidity", "relay", "fan", "light", "pump"].includes(capability));
  return hasCamera && hasEnvironment ? "mixed" : "mixed";
}

function resourceAwareStatus(status: "active", resources: ReturnType<typeof resourcesForNode>): NodeSummary["status"] {
  if (resources.cameras.unavailable > 0 || resources.sensors.degraded > 0) return "degraded";
  return status;
}

function statusOrder(status: NodeSummary["status"]) {
  switch (status) {
    case "active":
      return 0;
    case "degraded":
      return 1;
    case "pending":
      return 2;
    case "offline":
      return 3;
  }
}
