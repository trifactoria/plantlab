import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST as postEnvironment } from "../../src/app/api/agents/environment/route";
import { GET as getNodeEnvironment } from "../../src/app/api/nodes/[nodeName]/environment/route";
import {
  ENVIRONMENT_LIMITS,
  getLatestEnvironmentStatus,
  ingestEnvironmentTelemetry,
  parseEnvironmentBatch,
} from "../../src/lib/operations/environmentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sensor: {
      key: "greenhouse-ambient",
      name: "Greenhouse ambient",
      type: "dht22",
      gpio: 4,
      placement: "Top shelf",
      enabled: true,
    },
    capturedAt: "2026-07-13T15:30:00.000Z",
    classification: "accepted",
    temperatureC: 24.3,
    humidityPct: 67.2,
    diagnosticCode: null,
    diagnosticMessage: null,
    ...overrides,
  };
}

function jsonRequest(body: unknown, token?: string | null) {
  return new Request("http://localhost/api/agents/environment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function greenhouseFixture(name: string) {
  return JSON.parse(readFileSync(join(process.cwd(), "test-fixtures", "greenhouse", name), "utf8"));
}

describe("environment telemetry protocol", () => {
  it("parses shared greenhouse protocol fixtures", () => {
    const parsed = parseEnvironmentBatch(greenhouseFixture("valid-accepted-reading.json"), new Date("2026-07-13T15:31:00.000Z"));
    expect(parsed[0]).toMatchObject({ eventId: "fixture-accepted-1", temperatureC: 24.3, humidityPct: 67.2 });
    expect(() => parseEnvironmentBatch(greenhouseFixture("temperature-above-hard-limit.json"), new Date("2026-07-13T15:31:00.000Z"))).toThrow(
      /hard physical bounds/,
    );
    expect(() => parseEnvironmentBatch(greenhouseFixture("humidity-above-hard-limit.json"), new Date("2026-07-13T15:31:00.000Z"))).toThrow(
      /hard physical bounds/,
    );
  });

  it("stores an authenticated accepted batch and latest sensor status", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-accepted", role: "greenhouse-node", rotateCredential: true });
    const parsed = parseEnvironmentBatch({ events: [event({ eventId: "env-accepted-1" })] }, new Date("2026-07-13T15:31:00.000Z"));

    const result = await ingestEnvironmentTelemetry(prisma, registered.node.id, parsed);

    expect(result).toMatchObject({ acceptedEventIds: ["env-accepted-1"], storedReadings: 1, storedDiagnostics: 0 });
    const reading = await prisma.sensorReading.findUniqueOrThrow({ where: { nodeId_eventId: { nodeId: registered.node.id, eventId: "env-accepted-1" } } });
    expect(reading.temperatureC).toBe(24.3);
    const diagnostics = await prisma.sensorDiagnostic.findMany({ where: { nodeId: registered.node.id } });
    expect(diagnostics).toHaveLength(0);
    const status = await getLatestEnvironmentStatus(prisma, "greenhouse-env-accepted");
    expect(status?.sensors[0]).toMatchObject({
      key: "greenhouse-ambient",
      latestClassification: "accepted",
      latestTemperatureC: 24.3,
      latestHumidityPct: 67.2,
      stale: false,
      consecutiveFailures: 0,
      consecutiveRejects: 0,
    });
  });

  it("stores suspect/rejected/failed/stale/driver-unavailable as diagnostics, not normal readings", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-diag", role: "greenhouse-node", rotateCredential: true });
    const events = ["suspect", "rejected", "failed", "stale", "driver-unavailable"].map((classification, index) =>
      event({
        eventId: `env-diag-${classification}`,
        classification,
        temperatureC: classification === "failed" || classification === "stale" || classification === "driver-unavailable" ? null : 24 + index,
        humidityPct: classification === "failed" || classification === "stale" || classification === "driver-unavailable" ? null : 60 + index,
        diagnosticCode: `${classification}-code`,
        diagnosticMessage: `${classification} message`,
      }),
    );

    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events }, new Date("2026-07-13T15:31:00.000Z")));

    expect(await prisma.sensorReading.count({ where: { nodeId: registered.node.id } })).toBe(0);
    expect(await prisma.sensorDiagnostic.count({ where: { nodeId: registered.node.id } })).toBe(5);
  });

  it("is idempotent on eventId retry", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-retry", role: "greenhouse-node", rotateCredential: true });
    const parsed = parseEnvironmentBatch({ events: [event({ eventId: "env-retry-1" })] }, new Date("2026-07-13T15:31:00.000Z"));

    await ingestEnvironmentTelemetry(prisma, registered.node.id, parsed);
    const retry = await ingestEnvironmentTelemetry(prisma, registered.node.id, parsed);

    expect(retry.duplicateEventIds).toEqual(["env-retry-1"]);
    expect(await prisma.sensorReading.count({ where: { eventId: "env-retry-1" } })).toBe(1);
  });

  it("keeps configured sensor display fields user-owned while telemetry updates reported name and diagnostic state", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-metadata", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [event({ eventId: "env-meta-1", sensor: { key: "s1", name: "Old", type: "dht22", gpio: 4, placement: "Top", enabled: true } })] }, new Date("2026-07-13T15:31:00.000Z")));
    await prisma.nodeSensor.update({
      where: { nodeId_key: { nodeId: registered.node.id, key: "s1" } },
      data: { name: "User Sensor", displayName: "User Sensor", gpio: 4, placement: "Top shelf", enabled: true },
    });
    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [event({ eventId: "env-meta-2", sensor: { key: "s1", name: "New", type: "dht22", gpio: 17, placement: "Bottom", enabled: false } })] }, new Date("2026-07-13T15:32:00.000Z")));

    const sensor = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "s1" } } });
    expect(sensor).toMatchObject({ name: "User Sensor", displayName: "User Sensor", reportedName: "New", gpio: 4, placement: "Top shelf", enabled: true });
  });

  it("keeps sensors isolated per node", async () => {
    const a = await registerOrRotateNode(prisma, { name: "greenhouse-env-a", role: "greenhouse-node", rotateCredential: true });
    const b = await registerOrRotateNode(prisma, { name: "greenhouse-env-b", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(prisma, a.node.id, parseEnvironmentBatch({ events: [event({ eventId: "same-event-id", sensor: { key: "same", name: "A", type: "dht22", gpio: 4, placement: null, enabled: true } })] }, new Date("2026-07-13T15:31:00.000Z")));
    await ingestEnvironmentTelemetry(prisma, b.node.id, parseEnvironmentBatch({ events: [event({ eventId: "same-event-id", sensor: { key: "same", name: "B", type: "dht22", gpio: 5, placement: null, enabled: true } })] }, new Date("2026-07-13T15:31:00.000Z")));

    expect(await prisma.nodeSensor.count({ where: { key: "same" } })).toBe(2);
    expect(await prisma.sensorReading.count({ where: { eventId: "same-event-id" } })).toBe(2);
    expect((await getLatestEnvironmentStatus(prisma, "greenhouse-env-a"))?.sensors[0].name).toBe("A");
    expect((await getLatestEnvironmentStatus(prisma, "greenhouse-env-b"))?.sensors[0].name).toBe("B");
  });

  it("rejects malformed batches, excessive batches, and hard-bound violations", () => {
    expect(() => parseEnvironmentBatch({ events: "nope" })).toThrow(/events must be an array/);
    expect(() => parseEnvironmentBatch({ events: Array.from({ length: ENVIRONMENT_LIMITS.batchMaxEvents + 1 }, () => event()) })).toThrow(/at most/);
    expect(() => parseEnvironmentBatch({ events: [event({ temperatureC: 81 })] }, new Date("2026-07-13T15:31:00.000Z"))).toThrow(/hard physical bounds/);
    expect(() => parseEnvironmentBatch({ events: [event({ humidityPct: 101 })] }, new Date("2026-07-13T15:31:00.000Z"))).toThrow(/hard physical bounds/);
    expect(() => parseEnvironmentBatch({ events: [event({ temperatureC: Number.NaN })] }, new Date("2026-07-13T15:31:00.000Z"))).toThrow(/finite number/);
  });

  it("rejects an invalid mixed batch before storage", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-invalid-mixed", role: "greenhouse-node", rotateCredential: true });

    expect(() =>
      parseEnvironmentBatch(
        {
          events: [
            event({ eventId: "env-invalid-new", sensor: { key: "invalid-new", name: "New", type: "dht22", gpio: 4, placement: null, enabled: true } }),
            event({ eventId: "env-invalid-bad", sensor: { key: "invalid-bad", name: "Bad", type: "dht22", gpio: 99, placement: null, enabled: true } }),
          ],
        },
        new Date("2026-07-13T15:31:00.000Z"),
      ),
    ).toThrow(/BCM GPIO/);

    expect(await prisma.nodeSensor.count({ where: { nodeId: registered.node.id } })).toBe(0);
  });

  it("authenticates the route and rejects nodeName mismatch", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-route", role: "greenhouse-node", rotateCredential: true });
    const unauth = await postEnvironment(jsonRequest({ nodeName: "greenhouse-env-route", events: [event()] }, null));
    expect(unauth.status).toBe(401);

    const mismatch = await postEnvironment(jsonRequest({ nodeName: "other-node", events: [event({ eventId: "route-mismatch" })] }, registered.credential));
    expect(mismatch.status).toBe(403);

    const ok = await postEnvironment(
      jsonRequest({ nodeName: "greenhouse-env-route", events: [event({ eventId: "route-ok", capturedAt: new Date().toISOString() })] }, registered.credential),
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ acceptedEventIds: ["route-ok"] });
  });

  it("exposes latest status through the node environment route", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-env-latest-route", role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [event({ eventId: "latest-route-1" })] }, new Date("2026-07-13T15:31:00.000Z")));

    const response = await getNodeEnvironment(new Request("http://localhost"), { params: Promise.resolve({ nodeName: "greenhouse-env-latest-route" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sensors[0]).toMatchObject({ key: "greenhouse-ambient", latestClassification: "accepted" });
  });
});
