import { describe, expect, it } from "vitest";
import { getLatestEnvironmentStatus, ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { activeSensorsForNode, createDesiredSensorConfigRevision, mutateSensorConfiguration, reportAppliedSensorConfig } from "../../src/lib/operations/sensorConfig";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

function event(sensor: { key: string; name: string; gpio: number; placement?: string | null; enabled?: boolean }, eventId: string) {
  return {
    eventId,
    sensor: { type: "dht22", placement: null, enabled: true, ...sensor },
    capturedAt: "2026-07-14T10:00:00.000Z",
    classification: "accepted",
    temperatureC: 22,
    humidityPct: 55,
    diagnosticCode: null,
    diagnosticMessage: null,
  };
}

describe("sensor desired/applied configuration", () => {
  it("renames display name without changing internal identity or history", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "sensor-config-rename", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [event({ key: "outside", name: "Outside", gpio: 4 }, "rename-reading-1")] }, new Date("2026-07-14T10:01:00.000Z")),
    );
    const before = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "outside" } } });

    const revision = await mutateSensorConfiguration(prisma, "sensor-config-rename", { op: "rename", sensorKey: "outside", value: "Outside renamed" });
    await reportAppliedSensorConfig(prisma, registered.node.id, { revision: revision.revision, status: "applied" });

    const after = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "outside" } } });
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Outside renamed");
    expect(await prisma.sensorReading.count({ where: { sensorId: after.id } })).toBe(1);
  });

  it("rejects duplicate GPIO revisions atomically and keeps last-known-good applied revision", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "sensor-config-reject", role: "greenhouse-node", rotateCredential: true });
    const good = await createDesiredSensorConfigRevision(prisma, "sensor-config-reject", [
      { key: "a", name: "A", type: "dht22", gpio: 4, placement: "top", enabled: true },
      { key: "b", name: "B", type: "dht22", gpio: 17, placement: "bottom", enabled: true },
    ]);
    await reportAppliedSensorConfig(prisma, registered.node.id, { revision: good.revision, status: "applied" });

    await expect(
      createDesiredSensorConfigRevision(prisma, "sensor-config-reject", [
        { key: "a", name: "A", type: "dht22", gpio: 4, placement: "top", enabled: true },
        { key: "b", name: "B", type: "dht22", gpio: 4, placement: "bottom", enabled: true },
      ]),
    ).rejects.toThrow(/Duplicate BCM GPIO/);
    const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id } });
    expect(node.appliedSensorConfigRevision).toBe(good.revision);
  });

  it("disable and retire remove sensors from active config while history remains queryable", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "sensor-config-retire", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            event({ key: "active", name: "Active", gpio: 4 }, "active-reading"),
            event({ key: "retired", name: "Retired", gpio: 17 }, "retired-reading"),
          ],
        },
        new Date("2026-07-14T10:01:00.000Z"),
      ),
    );
    const revision = await mutateSensorConfiguration(prisma, "sensor-config-retire", { op: "retire", sensorKey: "retired" });
    await reportAppliedSensorConfig(prisma, registered.node.id, { revision: revision.revision, status: "applied" });

    expect((await activeSensorsForNode(prisma, registered.node.id)).map((sensor) => sensor.key)).toEqual(["active"]);
    expect((await getLatestEnvironmentStatus(prisma, "sensor-config-retire"))?.sensors.map((sensor) => sensor.key)).toEqual(["active"]);
    const retired = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "retired" } } });
    expect(await prisma.sensorReading.count({ where: { sensorId: retired.id } })).toBe(1);
  });

  it("marks historical sensors outside an applied revision inactive", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "sensor-config-stale-row", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            event({ key: "real", name: "Real", gpio: 4 }, "real-reading"),
            event({ key: "mock", name: "Mock", gpio: 17 }, "mock-reading"),
          ],
        },
        new Date("2026-07-14T10:01:00.000Z"),
      ),
    );

    const revision = await createDesiredSensorConfigRevision(prisma, "sensor-config-stale-row", [
      { key: "real", name: "Real", type: "dht22", gpio: 4, placement: "top", enabled: true },
    ]);
    await reportAppliedSensorConfig(prisma, registered.node.id, { revision: revision.revision, status: "applied" });

    expect((await activeSensorsForNode(prisma, registered.node.id)).map((sensor) => sensor.key)).toEqual(["real"]);
    const mock = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "mock" } } });
    expect(mock.configuredActive).toBe(false);
    expect(mock.appliedConfigRevision).toBeNull();
  });

  it("old nodes without applied revisions use the compatibility fallback", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "sensor-config-fallback", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [event({ key: "legacy", name: "Legacy", gpio: 4 }, "legacy-reading")] }, new Date("2026-07-14T10:01:00.000Z")),
    );

    expect((await activeSensorsForNode(prisma, registered.node.id)).map((sensor) => sensor.key)).toEqual(["legacy"]);
  });
});
