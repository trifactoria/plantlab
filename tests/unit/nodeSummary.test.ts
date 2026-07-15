import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getNodeSummaryRoute } from "../../src/app/api/nodes/summary/route";
import { getNodeSummaries } from "../../src/lib/operations/nodeSummary";
import { writeNodeConfigRaw } from "../../src/lib/operations/config";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

async function writeSelf(role: "coordinator" | "standalone", nodeName: string) {
  await writeNodeConfigRaw({
    formatVersion: 1,
    role,
    configuredAt: new Date("2026-07-13T00:00:00.000Z").toISOString(),
    hostname: nodeName,
    nodeName,
    coordinatorUrl: null,
    spoolRoot: null,
  });
}

type RegisteredNodeRole = Parameters<typeof registerOrRotateNode>[1]["role"];

async function registeredNode(name: string, role: RegisteredNodeRole, heartbeat: Date | null, capabilities: string[] = []) {
  const registered = await registerOrRotateNode(prisma, { name, role, rotateCredential: true });
  return prisma.plantLabNode.update({
    where: { id: registered.node.id },
    data: {
      lastHeartbeatAt: heartbeat,
      capabilitiesJson: JSON.stringify(capabilities),
    },
  });
}

async function addCamera(nodeId: string, suffix: string, overrides: Record<string, unknown> = {}) {
  return prisma.nodeCamera.create({
    data: {
      nodeId,
      stableId: `usb:${suffix}:${randomUUID()}`,
      devicePath: `/dev/video-${suffix}`,
      available: true,
      ...overrides,
    },
  });
}

async function addSensor(nodeId: string, key: string, overrides: Record<string, unknown> = {}) {
  return prisma.nodeSensor.create({
    data: {
      nodeId,
      key,
      name: key,
      displayName: key,
      type: "dht22",
      enabled: true,
      configuredActive: true,
      lastAttemptAt: new Date("2026-07-13T12:00:00.000Z"),
      lastAcceptedAt: new Date("2026-07-13T12:00:00.000Z"),
      latestClassification: "accepted",
      ...overrides,
    },
  });
}

describe("unified node summaries", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the coordinator self row first with destination URLs", async () => {
    const selfName = `plantlab-summary-${randomUUID()}`;
    await writeSelf("coordinator", selfName);
    const self = await registeredNode(selfName, "coordinator", new Date("2026-07-13T12:00:00.000Z"), ["camera"]);
    await addCamera(self.id, "self");

    const summaries = await getNodeSummaries(prisma, new Date("2026-07-13T12:00:00.000Z"));

    expect(summaries.nodes[0]).toMatchObject({
      name: selfName,
      relationship: "self",
      mode: "coordinator",
      online: true,
      resources: { cameras: { count: 1, active: 1, unavailable: 0 } },
      detailsUrl: `/nodes/${encodeURIComponent(selfName)}`,
      activityUrl: `/nodes/${encodeURIComponent(selfName)}/activity`,
      systemUrl: "/support",
    });
  });

  it("returns standalone self row with the same contract and local camera count", async () => {
    const selfName = `xps-summary-${randomUUID()}`;
    await writeSelf("standalone", selfName);
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "1");

    const summaries = await getNodeSummaries(prisma, new Date("2026-07-13T12:00:00.000Z"));

    expect(summaries.nodes[0]).toMatchObject({
      name: selfName,
      relationship: "self",
      mode: "standalone",
      resources: { cameras: { count: 1, active: 1, unavailable: 0 } },
      detailsUrl: "/",
      systemUrl: "/support",
    });
  });

  it("uses the OS hostname for the self row when local config only has localhost", async () => {
    await writeNodeConfigRaw({
      formatVersion: 1,
      role: "coordinator",
      configuredAt: new Date("2026-07-13T00:00:00.000Z").toISOString(),
      hostname: "localhost",
      nodeName: null,
      coordinatorUrl: null,
      spoolRoot: null,
    });

    const summaries = await getNodeSummaries(prisma, new Date("2026-07-13T12:00:00.000Z"));

    expect(summaries.nodes[0].relationship).toBe("self");
    expect(summaries.nodes[0].name).not.toBe("localhost");
  });

  it("summarizes attached camera, greenhouse, mixed, pending, and offline nodes in stable order", async () => {
    const selfName = `plantlab-order-${randomUUID()}`;
    await writeSelf("coordinator", selfName);
    const now = new Date("2026-07-13T12:00:00.000Z");
    const cameraNode = await registeredNode(`camera-node-${randomUUID()}`, "camera-node", now, ["camera"]);
    const greenhouse = await registeredNode(`greenhouse-node-${randomUUID()}`, "greenhouse-node", now, ["camera", "temperature", "humidity"]);
    const mixed = await registeredNode(`mixed-node-${randomUUID()}`, "microscope-node", now, ["camera", "temperature"]);
    const pending = await registeredNode(`pending-node-${randomUUID()}`, "camera-node", null, ["camera"]);
    const offline = await registeredNode(`offline-node-${randomUUID()}`, "greenhouse-node", new Date("2026-07-13T10:00:00.000Z"), ["temperature"]);

    await addCamera(cameraNode.id, "attached");
    for (const index of [1, 2, 3]) await addCamera(greenhouse.id, `greenhouse-${index}`);
    await addCamera(greenhouse.id, "codec", { available: false });
    await addCamera(greenhouse.id, "retired", { retiredAt: new Date("2026-07-13T11:00:00.000Z") });
    await addCamera(mixed.id, "mixed");
    for (const key of ["outside", "bottom", "middle"]) await addSensor(greenhouse.id, key);
    await addSensor(greenhouse.id, "top", { lastAcceptedAt: new Date("2026-07-13T11:50:00.000Z"), latestClassification: "failed", consecutiveFailures: 4 });
    await addSensor(greenhouse.id, "ambient", { configuredActive: false });
    await addSensor(greenhouse.id, "old", { retiredAt: new Date("2026-07-13T11:00:00.000Z") });

    const summaries = await getNodeSummaries(prisma, now);
    const byName = new Map(summaries.nodes.map((node) => [node.name, node]));

    expect(byName.get(cameraNode.name)).toMatchObject({ relationship: "attached", mode: "camera-node", status: "active", resources: { cameras: { count: 1 } } });
    expect(byName.get(greenhouse.name)).toMatchObject({
      mode: "greenhouse-node",
      status: "degraded",
      resources: { cameras: { count: 3, active: 3, unavailable: 0 }, sensors: { count: 4, active: 4, degraded: 1 } },
      detailsUrl: `/nodes/${encodeURIComponent(greenhouse.name)}`,
      activityUrl: `/nodes/${encodeURIComponent(greenhouse.name)}/activity`,
      systemUrl: null,
    });
    expect(byName.get(mixed.name)).toMatchObject({ mode: "mixed" });
    expect(byName.get(pending.name)).toMatchObject({ status: "pending", activity: { kind: "pending" } });
    expect(byName.get(offline.name)).toMatchObject({ status: "offline", online: false });
    expect(summaries.nodes[0]).toMatchObject({ name: selfName, relationship: "self" });
  });

  it("exposes the node summary route", async () => {
    const selfName = `plantlab-route-${randomUUID()}`;
    await writeSelf("coordinator", selfName);
    const response = await getNodeSummaryRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.nodes[0]).toMatchObject({ name: selfName, relationship: "self" });
    expect(body.ordering).toContain("self first");
  });
});
