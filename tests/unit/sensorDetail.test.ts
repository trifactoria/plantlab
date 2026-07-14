import { describe, expect, it } from "vitest";
import { GET as getSensorDetailRoute } from "../../src/app/api/nodes/[nodeName]/sensors/[sensorKey]/route";
import { getSensorDetail, ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

function event(overrides: Record<string, unknown> = {}) {
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

async function setUpNode(name: string) {
  return registerOrRotateNode(prisma, { name, role: "greenhouse-node", rotateCredential: true });
}

describe("getSensorDetail", () => {
  it("404s for an unknown node or sensor", async () => {
    await setUpNode("greenhouse-detail-404");
    expect((await getSensorDetail(prisma, "does-not-exist", "greenhouse-middle")).ok).toBe(false);
    expect((await getSensorDetail(prisma, "greenhouse-detail-404", "does-not-exist")).ok).toBe(false);
  });

  it("reflects fresh state with the latest accepted reading", async () => {
    const registered = await setUpNode("greenhouse-detail-fresh");
    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [event({ eventId: "fresh-1" })] }, new Date("2026-07-14T15:31:00.000Z")));

    const detail = await getSensorDetail(prisma, "greenhouse-detail-fresh", "greenhouse-middle");
    if (!detail.ok) throw new Error("expected ok");
    expect(detail.sensor.latestClassification).toBe("accepted");
    expect(detail.sensor.latestTemperatureC).toBe(24.3);
    expect(detail.events[0]).toMatchObject({ kind: "accepted", temperatureC: 24.3, humidityPct: 67.2 });
  });

  it("reflects failed state with diagnostic code/message and no fabricated reading", async () => {
    const registered = await setUpNode("greenhouse-detail-failed");
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        { events: [event({ eventId: "failed-1", classification: "failed", temperatureC: null, humidityPct: null, diagnosticCode: "sensor-no-response", diagnosticMessage: "No DHT22 response pulses were received." })] },
        new Date("2026-07-14T15:31:00.000Z"),
      ),
    );

    const detail = await getSensorDetail(prisma, "greenhouse-detail-failed", "greenhouse-middle");
    if (!detail.ok) throw new Error("expected ok");
    expect(detail.sensor.latestClassification).toBe("failed");
    expect(detail.sensor.latestTemperatureC).toBeNull();
    expect(detail.sensor.lastDiagnosticCode).toBe("sensor-no-response");
    expect(detail.events[0]).toMatchObject({ kind: "diagnostic", classification: "failed", temperatureC: null, humidityPct: null, code: "sensor-no-response" });
  });

  it("reflects stale and rejected classifications distinctly", async () => {
    const registered = await setUpNode("greenhouse-detail-stale-rejected");
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            event({ eventId: "stale-1", classification: "stale", temperatureC: null, humidityPct: null, diagnosticCode: "stale", diagnosticMessage: "No accepted environmental reading has arrived within the stale timeout." }),
          ],
        },
        new Date("2026-07-14T15:31:00.000Z"),
      ),
    );
    let detail = await getSensorDetail(prisma, "greenhouse-detail-stale-rejected", "greenhouse-middle");
    if (!detail.ok) throw new Error("expected ok");
    expect(detail.sensor.stale).toBe(true);

    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        { events: [event({ eventId: "rejected-1", classification: "rejected", temperatureC: 55, humidityPct: 50, diagnosticCode: "temperature-plausible-bound", diagnosticMessage: "Temperature is outside configured plausible greenhouse bounds." })] },
        new Date("2026-07-14T15:32:00.000Z"),
      ),
    );
    detail = await getSensorDetail(prisma, "greenhouse-detail-stale-rejected", "greenhouse-middle");
    if (!detail.ok) throw new Error("expected ok");
    expect(detail.sensor.latestClassification).toBe("rejected");
  });

  it("denormalizes the currently-configured GPIO onto each diagnostic row", async () => {
    const registered = await setUpNode("greenhouse-detail-gpio");
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({ events: [event({ eventId: "gpio-1", classification: "failed", temperatureC: null, humidityPct: null, diagnosticCode: "sensor-no-response", diagnosticMessage: "no response" })] }, new Date("2026-07-14T15:31:00.000Z")),
    );
    const detail = await getSensorDetail(prisma, "greenhouse-detail-gpio", "greenhouse-middle");
    if (!detail.ok) throw new Error("expected ok");
    expect(detail.events[0].gpio).toBe(17);
  });

  it("never stores an out-of-hard-bound value as a valid measurement", () => {
    expect(() => parseEnvironmentBatch({ events: [event({ eventId: "bad-temp", temperatureC: 999 })] }, new Date("2026-07-14T15:31:00.000Z"))).toThrow(/hard physical bounds/);
  });

  it("merges accepted readings and diagnostics into one time-ordered event history via the route", async () => {
    const registered = await setUpNode("greenhouse-detail-merged");
    await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events: [event({ eventId: "merged-1", capturedAt: "2026-07-14T15:30:00.000Z" })] }, new Date("2026-07-14T15:31:00.000Z")));
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        { events: [event({ eventId: "merged-2", capturedAt: "2026-07-14T15:31:00.000Z", classification: "failed", temperatureC: null, humidityPct: null, diagnosticCode: "sensor-no-response", diagnosticMessage: "no response" })] },
        new Date("2026-07-14T15:32:00.000Z"),
      ),
    );

    const response = await getSensorDetailRoute(new Request("http://localhost"), { params: Promise.resolve({ nodeName: "greenhouse-detail-merged", sensorKey: "greenhouse-middle" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(["diagnostic", "accepted"]);
  });
});
