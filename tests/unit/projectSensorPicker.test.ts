import { afterEach, describe, expect, it } from "vitest";
import { GET as getAvailableSensors } from "../../src/app/api/sensors/available/route";
import { POST as linkProjectSensorRoute } from "../../src/app/api/projects/[projectId]/sensors/route";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { listAvailableProjectSensors } from "../../src/lib/operations/projectSensors";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

function event(sensor: { key: string; name: string; gpio: number }, eventId: string) {
  return {
    eventId,
    sensor: { type: "dht22", placement: null, enabled: true, ...sensor },
    capturedAt: "2026-07-14T10:00:00.000Z",
    classification: "accepted",
    temperatureC: 21,
    humidityPct: 50,
    diagnosticCode: null,
    diagnosticMessage: null,
  };
}

describe("listAvailableProjectSensors / GET /api/sensors/available", () => {
  const nodeNames: string[] = [];

  afterEach(async () => {
    for (const name of nodeNames.splice(0)) {
      await prisma.plantLabNode.deleteMany({ where: { name } });
    }
  });

  it("lists applied/configured-active sensors across nodes and excludes retired ones", async () => {
    const nodeName = `vitest-sensor-picker-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const registered = await registerOrRotateNode(prisma, { name: nodeName, role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [event({ key: "outside", name: "Outside", gpio: 4 }, "picker-1")] }, new Date("2026-07-14T10:01:00.000Z")),
    );
    const retired = await prisma.nodeSensor.create({
      data: { nodeId: registered.node.id, key: "old-probe", name: "Old Probe", type: "dht22", gpio: 9, enabled: false, configuredActive: false, retiredAt: new Date() },
    });

    const result = await listAvailableProjectSensors(prisma);
    const forNode = result.filter((sensor) => sensor.node.id === registered.node.id);

    expect(forNode).toHaveLength(1);
    expect(forNode[0]).toMatchObject({ key: "outside", name: "Outside", node: { name: nodeName, role: "greenhouse-node" } });
    expect(forNode.some((sensor) => sensor.id === retired.id)).toBe(false);
  });

  it("GET /api/sensors/available serves the same list", async () => {
    const nodeName = `vitest-sensor-picker-route-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const registered = await registerOrRotateNode(prisma, { name: nodeName, role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [event({ key: "middle", name: "Middle", gpio: 27 }, "picker-2")] }, new Date("2026-07-14T10:01:00.000Z")),
    );

    const response = await getAvailableSensors();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sensors.some((sensor: { key: string; node: { name: string } }) => sensor.key === "middle" && sensor.node.name === nodeName)).toBe(true);
  });

  it("a linked binding's sensor payload carries the current reading and freshness fields the dashboard/photo card need", async () => {
    const nodeName = `vitest-sensor-picker-reading-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const registered = await registerOrRotateNode(prisma, { name: nodeName, role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [event({ key: "outside", name: "Outside", gpio: 4 }, "picker-3")] }, new Date("2026-07-14T10:01:00.000Z")),
    );
    const sensor = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "outside" } } });
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null });

    try {
      const response = await linkProjectSensorRoute(
        new Request(`http://localhost/api/projects/${project.id}/sensors`, {
          method: "POST",
          body: JSON.stringify({ sensorId: sensor.id }),
          headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ projectId: project.id }) },
      );
      const binding = await response.json();
      expect(response.status).toBe(201);
      expect(binding.sensor).toMatchObject({ latestClassification: "accepted", latestTemperatureC: 21, latestHumidityPct: 50 });
      expect(binding.sensor.lastAcceptedAt).not.toBeNull();
    } finally {
      await cleanupTestProject(prisma, project.id, project.localPhotoDirectory);
    }
  });
});
