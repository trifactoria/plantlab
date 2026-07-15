import type { PrismaClient } from "@prisma/client";
import { computeNodeStatus, hasActiveCredential } from "./nodeCredentials";
import { parseCapabilities } from "./capabilities";
import { activeSensorsForNode } from "./sensorConfig";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/nodeDetail.ts is server-only operational code.");
}

export async function getNodeSummary(prisma: PrismaClient, nodeName: string) {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: {
      cameras: { select: { id: true, available: true, retiredAt: true, assignments: { where: { active: true }, select: { id: true } } } },
      outlets: { select: { id: true, actualState: true, available: true } },
    },
  });
  if (!node) return null;
  const activeSensors = await activeSensorsForNode(prisma, node.id);
  const retiredSensorCount = await prisma.nodeSensor.count({ where: { nodeId: node.id, retiredAt: { not: null } } });

  const [activeCredential, captureQueued, captureClaimed, powerPending, powerClaimed, testsPending, testsClaimed, testsRunning] = await Promise.all([
    hasActiveCredential(prisma, node.id),
    prisma.agentCaptureJob.count({ where: { nodeId: node.id, status: "queued" } }),
    prisma.agentCaptureJob.count({ where: { nodeId: node.id, status: "claimed" } }),
    prisma.powerCommand.count({ where: { nodeId: node.id, status: "pending", expiresAt: { gt: new Date() } } }),
    prisma.powerCommand.count({ where: { nodeId: node.id, status: "claimed", expiresAt: { gt: new Date() } } }),
    prisma.sensorTestCommand.count({ where: { nodeId: node.id, status: "pending", expiresAt: { gt: new Date() } } }),
    prisma.sensorTestCommand.count({ where: { nodeId: node.id, status: "claimed", expiresAt: { gt: new Date() } } }),
    prisma.sensorTestCommand.count({ where: { nodeId: node.id, status: "running", expiresAt: { gt: new Date() } } }),
  ]);

  const healthySensors = activeSensors.filter((sensor) => sensor.latestClassification === "accepted").length;
  const failedSensors = activeSensors.filter((sensor) => sensor.latestClassification === "failed" || sensor.latestClassification === "driver-unavailable").length;
  const staleSensors = activeSensors.filter((sensor) => sensor.latestClassification === "stale").length;
  const rejectedSensors = activeSensors.filter((sensor) => sensor.latestClassification === "rejected" || sensor.latestClassification === "suspect").length;

  return {
    node: {
      id: node.id,
      name: node.name,
      role: node.role,
      hostname: node.hostname,
      operatingSystem: node.operatingSystem,
      architecture: node.architecture,
      runtime: node.runtime,
      softwareVersion: node.softwareVersion,
      protocolVersion: node.protocolVersion,
      coordinatorUrl: node.coordinatorUrl,
      lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
      lastInventoryAt: node.lastInventoryAt?.toISOString() ?? null,
      statusLabel: computeNodeStatus(node, activeCredential),
      capabilities: parseCapabilities(node.capabilitiesJson),
    },
    cameras: {
      total: node.cameras.filter((camera) => !camera.retiredAt).length,
      available: node.cameras.filter((camera) => camera.available && !camera.retiredAt).length,
      unavailable: node.cameras.filter((camera) => !camera.available && !camera.retiredAt).length,
      // Unavailable cameras that still have an active capture assignment are
      // the actionable problem (a scheduled capture is pointed at a camera
      // that isn't there) - the reattach workflow targets exactly these.
      unavailableAssigned: node.cameras.filter((camera) => !camera.available && !camera.retiredAt && camera.assignments.length > 0).length,
      retired: node.cameras.filter((camera) => camera.retiredAt).length,
    },
    sensors: {
      total: activeSensors.length,
      healthy: healthySensors,
      failed: failedSensors,
      stale: staleSensors,
      rejected: rejectedSensors,
      retired: retiredSensorCount,
      desiredRevision: node.desiredSensorConfigRevision,
      appliedRevision: node.appliedSensorConfigRevision,
      appliedStatus: node.appliedSensorConfigStatus,
      // Desired/applied drift: the coordinator wants a newer revision than
      // the node has acknowledged applying.
      drift:
        node.desiredSensorConfigRevision !== null &&
        node.appliedSensorConfigRevision !== null &&
        node.desiredSensorConfigRevision !== node.appliedSensorConfigRevision,
      configPending: node.appliedSensorConfigStatus === "pending",
      configRejected: node.appliedSensorConfigStatus === "rejected",
    },
    power: {
      total: node.outlets.length,
      on: node.outlets.filter((outlet) => outlet.actualState === true).length,
      off: node.outlets.filter((outlet) => outlet.actualState === false).length,
      unknown: node.outlets.filter((outlet) => outlet.actualState === null || !outlet.available).length,
    },
    queue: {
      capture: { queued: captureQueued, claimed: captureClaimed },
      power: { pending: powerPending, claimed: powerClaimed },
      sensorTests: { pending: testsPending, claimed: testsClaimed, running: testsRunning },
    },
  };
}

export type NodeTimelineFilter = "all" | "sensors" | "power" | "cameras" | "agent";

export type NodeTimelineEntry = {
  id: string;
  at: string;
  category: "sensors" | "power" | "cameras" | "agent";
  summary: string;
  detail: string | null;
  tone: "info" | "success" | "warning" | "error";
};

/**
 * A unified recent-activity view composed entirely from already-persisted
 * rows (SensorDiagnostic, PowerCommand, SensorTestCommand, node heartbeat/
 * inventory timestamps) - deliberately not a new logging system, per the
 * task's "avoid duplicate logging systems unnecessarily."
 */
export async function getNodeTimeline(prisma: PrismaClient, nodeName: string, filter: NodeTimelineFilter = "all", limit = 40): Promise<NodeTimelineEntry[] | null> {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: { sensors: { select: { id: true, key: true, name: true } } },
  });
  if (!node) return null;

  const entries: NodeTimelineEntry[] = [];
  const sensorsById = new Map(node.sensors.map((sensor) => [sensor.id, sensor]));

  if (filter === "all" || filter === "sensors") {
    const diagnostics = await prisma.sensorDiagnostic.findMany({ where: { nodeId: node.id }, orderBy: { capturedAt: "desc" }, take: limit });
    for (const diagnostic of diagnostics) {
      const sensor = sensorsById.get(diagnostic.sensorId);
      const tone: NodeTimelineEntry["tone"] = diagnostic.classification === "accepted" ? "success" : diagnostic.classification === "stale" ? "warning" : "error";
      entries.push({
        id: `diagnostic:${diagnostic.id}`,
        at: diagnostic.capturedAt.toISOString(),
        category: "sensors",
        summary: `Sensor ${sensor?.name ?? diagnostic.sensorId} ${diagnostic.classification}${diagnostic.code ? `: ${diagnostic.code}` : ""}`,
        detail: diagnostic.message,
        tone,
      });
    }
    const tests = await prisma.sensorTestCommand.findMany({
      where: { nodeId: node.id, status: { in: ["succeeded", "failed", "expired"] } },
      orderBy: { requestedAt: "desc" },
      take: limit,
    });
    for (const test of tests) {
      entries.push({
        id: `sensor-test:${test.id}`,
        at: (test.completedAt ?? test.requestedAt).toISOString(),
        category: "sensors",
        summary: `Sensor test on ${test.sensorKey} ${test.status}`,
        detail: test.errorMessage ?? (test.finalPass === false ? `${test.failedCount ?? 0} of ${test.attemptsCompleted ?? test.attemptsRequested} attempts failed` : null),
        tone: test.status === "succeeded" ? "success" : test.status === "expired" ? "warning" : "error",
      });
    }
  }

  if (filter === "all" || filter === "power") {
    const commands = await prisma.powerCommand.findMany({
      where: { nodeId: node.id, status: { in: ["succeeded", "failed", "expired"] } },
      orderBy: { requestedAt: "desc" },
      take: limit,
    });
    for (const command of commands) {
      const label = command.requestedBy?.startsWith("schedule:") ? "Power schedule" : "Power command";
      entries.push({
        id: `power:${command.id}`,
        at: (command.completedAt ?? command.requestedAt).toISOString(),
        category: "power",
        summary: `${label} ${command.outletKey} ${command.action.toUpperCase()} ${command.status}`,
        detail: command.errorMessage,
        tone: command.status === "succeeded" ? "success" : command.status === "expired" ? "warning" : "error",
      });
    }
  }

  if (filter === "all" || filter === "cameras") {
    if (node.lastInventoryAt) {
      entries.push({
        id: "camera-inventory",
        at: node.lastInventoryAt.toISOString(),
        category: "cameras",
        summary: "Camera inventory received",
        detail: null,
        tone: "info",
      });
    }
  }

  if (filter === "all" || filter === "agent") {
    if (node.lastHeartbeatAt) {
      entries.push({
        id: "heartbeat",
        at: node.lastHeartbeatAt.toISOString(),
        category: "agent",
        summary: "Heartbeat accepted",
        detail: null,
        tone: "success",
      });
    }
  }

  return entries.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}
