import { describe, expect, it } from "vitest";
import { GET as nextSensorTestRoute } from "../../src/app/api/agents/sensor-tests/next/route";
import { POST as claimSensorTestRoute } from "../../src/app/api/agents/sensor-tests/[commandId]/claim/route";
import { POST as startSensorTestRoute } from "../../src/app/api/agents/sensor-tests/[commandId]/start/route";
import { POST as reportSensorTestRoute } from "../../src/app/api/agents/sensor-tests/[commandId]/report/route";
import { POST as failSensorTestRoute } from "../../src/app/api/agents/sensor-tests/[commandId]/fail/route";
import { POST as createSensorTestRoute } from "../../src/app/api/nodes/[nodeName]/sensors/[sensorKey]/test/route";
import { POST as runDiagnosticsRoute } from "../../src/app/api/nodes/[nodeName]/diagnostics/route";
import { GET as nodeSummaryRoute } from "../../src/app/api/nodes/[nodeName]/route";
import { GET as nodeTimelineRoute } from "../../src/app/api/nodes/[nodeName]/timeline/route";
import {
  claimSensorTestCommand,
  createSensorTestCommand,
  MAX_TEST_ATTEMPTS,
} from "../../src/lib/operations/sensorTestProtocol";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

function jsonRequest(method: string, body?: unknown, token?: string | null) {
  return new Request("http://localhost", {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function envEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sensor: { key: "greenhouse-middle", name: "Greenhouse Middle Shelf", type: "dht22", gpio: 17, placement: "middle-shelf", enabled: true },
    capturedAt: "2026-07-14T15:30:00.000Z",
    classification: "accepted",
    temperatureC: 24.3,
    humidityPct: 67.2,
    diagnosticCode: null,
    diagnosticMessage: null,
    ...overrides,
  };
}

async function setUpNodeWithSensor(name: string, sensorKey = "greenhouse-middle") {
  const registered = await registerOrRotateNode(prisma, { name, role: "greenhouse-node", rotateCredential: true });
  await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [envEvent({ eventId: `${name}-seed`, sensor: { key: sensorKey, name: sensorKey, type: "dht22", gpio: 17, placement: null, enabled: true } })] }, new Date("2026-07-14T15:31:00.000Z")));
  return registered;
}

describe("sensor test command lifecycle", () => {
  it("goes pending -> claimed -> running -> succeeded through the full agent protocol", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-test-lifecycle");

    const created = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-lifecycle", sensorKey: "greenhouse-middle" }) });
    expect(created.status).toBe(201);
    const { command } = await created.json();
    expect(command.status).toBe("pending");

    const next = await nextSensorTestRoute(new Request("http://localhost", { headers: { authorization: `Bearer ${registered.credential}` } }));
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    expect(nextBody.command).toMatchObject({ id: command.id, sensorKey: "greenhouse-middle" });

    const claimed = await claimSensorTestRoute(jsonRequest("POST", {}, registered.credential), { params: Promise.resolve({ commandId: command.id }) });
    expect(claimed.status).toBe(200);

    const started = await startSensorTestRoute(jsonRequest("POST", {}, registered.credential), { params: Promise.resolve({ commandId: command.id }) });
    expect(started.status).toBe(200);

    const reported = await reportSensorTestRoute(
      jsonRequest(
        "POST",
        {
          attemptsCompleted: 5,
          acceptedCount: 5,
          failedCount: 0,
          finalPass: true,
          effectiveDriver: "pigpio",
          configuredGpio: 17,
          attempts: [{ attempt: 1, classification: "accepted", code: null, message: null, temperatureC: 24.1, humidityPct: 55.0 }],
        },
        registered.credential,
      ),
      { params: Promise.resolve({ commandId: command.id }) },
    );
    expect(reported.status).toBe(200);
    const reportedBody = await reported.json();
    expect(reportedBody.status).toBe("succeeded");

    const stored = await prisma.sensorTestCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(stored.finalPass).toBe(true);
    expect(JSON.parse(stored.attemptsJson ?? "[]")).toHaveLength(1);
  });

  it("reports failed when finalPass is false", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-test-failed");
    const created = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-failed", sensorKey: "greenhouse-middle" }) });
    const { command } = await created.json();
    await claimSensorTestCommand(prisma, registered.node.id, command.id);

    const reported = await reportSensorTestRoute(
      jsonRequest("POST", { attemptsCompleted: 5, acceptedCount: 0, failedCount: 5, finalPass: false, effectiveDriver: "pigpio", configuredGpio: 17, attempts: [] }, registered.credential),
      { params: Promise.resolve({ commandId: command.id }) },
    );
    expect((await reported.json()).status).toBe("failed");
  });

  it("fails a test for an unconfigured sensor via the infra-failure path", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-test-unconfigured");
    const created = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-unconfigured", sensorKey: "greenhouse-middle" }) });
    const { command } = await created.json();

    const failed = await failSensorTestRoute(jsonRequest("POST", { errorCode: "sensor-not-configured", errorMessage: "not configured" }, registered.credential), { params: Promise.resolve({ commandId: command.id }) });
    expect(failed.status).toBe(200);
    const stored = await prisma.sensorTestCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("sensor-not-configured");
  });

  it("prevents a second simultaneous test for the same sensor", async () => {
    await setUpNodeWithSensor("greenhouse-test-duplicate");
    const first = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-duplicate", sensorKey: "greenhouse-middle" }) });
    expect(first.status).toBe(201);

    const second = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-duplicate", sensorKey: "greenhouse-middle" }) });
    expect(second.status).toBe(409);
  });

  it("expires a test that is never claimed in time", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-test-expire");
    const created = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-expire", sensorKey: "greenhouse-middle" }) });
    const { command } = await created.json();
    await prisma.sensorTestCommand.update({ where: { id: command.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await nextSensorTestRoute(new Request("http://localhost", { headers: { authorization: `Bearer ${registered.credential}` } }));

    const stored = await prisma.sensorTestCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(stored.status).toBe("expired");
  });

  it("recovers a stale-claimed test and eventually fails it after MAX attempts, unblocking the sensor", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-test-stale");
    const created = await createSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ nodeName: "greenhouse-test-stale", sensorKey: "greenhouse-middle" }) });
    const { command } = await created.json();

    for (let i = 0; i < MAX_TEST_ATTEMPTS; i += 1) {
      await nextSensorTestRoute(new Request("http://localhost", { headers: { authorization: `Bearer ${registered.credential}` } }));
      await claimSensorTestCommand(prisma, registered.node.id, command.id);
      await prisma.sensorTestCommand.update({ where: { id: command.id }, data: { claimedAt: new Date(Date.now() - 60_000) } });
    }
    await nextSensorTestRoute(new Request("http://localhost", { headers: { authorization: `Bearer ${registered.credential}` } }));

    const stored = await prisma.sensorTestCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("sensor-test-stale");

    const nextAttempt = await createSensorTestCommand(prisma, "greenhouse-test-stale", { sensorKey: "greenhouse-middle" });
    expect(nextAttempt.ok).toBe(true);
  });
});

describe("authorization on agent sensor-test endpoints", () => {
  it("rejects unauthenticated requests on every agent-facing endpoint", async () => {
    const next = await nextSensorTestRoute(new Request("http://localhost"));
    expect(next.status).toBe(401);

    const claim = await claimSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ commandId: "does-not-exist" }) });
    expect(claim.status).toBe(401);

    const start = await startSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ commandId: "does-not-exist" }) });
    expect(start.status).toBe(401);

    const report = await reportSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ commandId: "does-not-exist" }) });
    expect(report.status).toBe(401);

    const fail = await failSensorTestRoute(jsonRequest("POST", {}), { params: Promise.resolve({ commandId: "does-not-exist" }) });
    expect(fail.status).toBe(401);
  });

  it("rejects a bogus credential too, not just a missing one", async () => {
    const next = await nextSensorTestRoute(new Request("http://localhost", { headers: { authorization: "Bearer pln_totally-invalid" } }));
    expect(next.status).toBe(401);
  });
});

describe("node summary reflects partial hardware failure with a healthy heartbeat", () => {
  it("shows failed sensor counts alongside an active node status", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-node-partial");
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        { events: [envEvent({ eventId: "partial-1", sensor: { key: "greenhouse-other", name: "Other", type: "dht22", gpio: 4, placement: null, enabled: true }, classification: "failed", temperatureC: null, humidityPct: null, diagnosticCode: "sensor-no-response", diagnosticMessage: "no response" })] },
        new Date("2026-07-14T15:32:00.000Z"),
      ),
    );

    const response = await nodeSummaryRoute(new Request("http://localhost"), { params: Promise.resolve({ nodeName: "greenhouse-node-partial" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sensors.total).toBe(2);
    expect(body.sensors.healthy).toBe(1);
    expect(body.sensors.failed).toBe(1);
  });

  it("does not let a retired/no-longer-configured sensor inflate the total or failed counts", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-node-retired");
    // A sensor that stopped being sampled >1h ago (e.g. dropped from the
    // edge's config, like the real greenhouse-ambient row) while the rest
    // of the node keeps reporting normally.
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            envEvent({
              eventId: "retired-1",
              sensor: { key: "greenhouse-retired", name: "Retired", type: "dht22", gpio: 4, placement: null, enabled: true },
              classification: "failed",
              temperatureC: null,
              humidityPct: null,
              diagnosticCode: "sensor-no-response",
              diagnosticMessage: "no response",
              capturedAt: "2026-07-14T10:00:00.000Z",
            }),
          ],
        },
        new Date("2026-07-14T10:00:01.000Z"),
      ),
    );
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [envEvent({ eventId: "retired-2", capturedAt: "2026-07-14T15:32:00.000Z" })] }, new Date("2026-07-14T15:32:01.000Z")),
    );

    const response = await nodeSummaryRoute(new Request("http://localhost"), { params: Promise.resolve({ nodeName: "greenhouse-node-retired" }) });
    const body = await response.json();
    expect(body.sensors.total).toBe(1);
    expect(body.sensors.healthy).toBe(1);
    expect(body.sensors.failed).toBe(0);
  });
});

describe("node diagnostics sweep", () => {
  it("queues a bounded test for every enabled sensor and one existing active test does not block the others", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-node-sweep", "greenhouse-a");
    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [envEvent({ eventId: "sweep-b", sensor: { key: "greenhouse-b", name: "B", type: "dht22", gpio: 4, placement: null, enabled: true } })] }, new Date("2026-07-14T15:32:00.000Z")));

    await createSensorTestCommand(prisma, "greenhouse-node-sweep", { sensorKey: "greenhouse-a" });

    const response = await runDiagnosticsRoute(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ nodeName: "greenhouse-node-sweep" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    const byKey = Object.fromEntries(body.results.map((r: { sensorKey: string; ok: boolean }) => [r.sensorKey, r.ok]));
    expect(byKey["greenhouse-a"]).toBe(false); // already active - conflict
    expect(byKey["greenhouse-b"]).toBe(true);
  });
});

describe("node timeline", () => {
  it("orders entries newest-first and filters by category", async () => {
    const registered = await setUpNodeWithSensor("greenhouse-timeline");
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        { events: [envEvent({ eventId: "timeline-1", classification: "failed", temperatureC: null, humidityPct: null, diagnosticCode: "sensor-no-response", diagnosticMessage: "no response", capturedAt: "2026-07-14T15:30:00.000Z" })] },
        new Date("2026-07-14T15:31:00.000Z"),
      ),
    );
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        { events: [envEvent({ eventId: "timeline-2", classification: "rejected", temperatureC: 55, humidityPct: 50, diagnosticCode: "temperature-plausible-bound", diagnosticMessage: "outside plausible bounds", capturedAt: "2026-07-14T15:35:00.000Z" })] },
        new Date("2026-07-14T15:36:00.000Z"),
      ),
    );

    const allResponse = await nodeTimelineRoute(new Request("http://localhost/api/nodes/greenhouse-timeline/timeline?filter=all"), { params: Promise.resolve({ nodeName: "greenhouse-timeline" }) });
    const all = (await allResponse.json()).entries as Array<{ at: string; category: string }>;
    expect(all.length).toBeGreaterThanOrEqual(2);
    const sensorEntries = all.filter((entry) => entry.category === "sensors");
    expect(new Date(sensorEntries[0].at).getTime()).toBeGreaterThanOrEqual(new Date(sensorEntries[1].at).getTime());

    const sensorsOnly = await nodeTimelineRoute(new Request("http://localhost/api/nodes/greenhouse-timeline/timeline?filter=sensors"), { params: Promise.resolve({ nodeName: "greenhouse-timeline" }) });
    const sensorsBody = (await sensorsOnly.json()).entries as Array<{ category: string }>;
    expect(sensorsBody.every((entry) => entry.category === "sensors")).toBe(true);

    const powerOnly = await nodeTimelineRoute(new Request("http://localhost/api/nodes/greenhouse-timeline/timeline?filter=power"), { params: Promise.resolve({ nodeName: "greenhouse-timeline" }) });
    expect((await powerOnly.json()).entries).toEqual([]);
  });

  it("404s for an unknown node", async () => {
    const response = await nodeTimelineRoute(new Request("http://localhost/api/nodes/does-not-exist/timeline"), { params: Promise.resolve({ nodeName: "does-not-exist" }) });
    expect(response.status).toBe(404);
  });
});
