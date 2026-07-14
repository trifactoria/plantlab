import { describe, expect, it } from "vitest";
import { GET as getMetricHistoryRoute } from "../../src/app/api/nodes/[nodeName]/metrics/history/route";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

function envEvent(overrides: Record<string, unknown> = {}) {
  const { sensor: sensorOverride, ...rest } = overrides;
  const sensor = {
    key: "greenhouse-outside",
    name: "Outside",
    type: "dht22",
    gpio: 4,
    placement: "outside",
    enabled: true,
    ...((sensorOverride as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    eventId: `${sensor.key}-${rest.capturedAt ?? "2026-07-14T10:00:00.000Z"}-${rest.classification ?? "accepted"}`,
    sensor,
    capturedAt: "2026-07-14T10:00:00.000Z",
    classification: "accepted",
    temperatureC: 20,
    humidityPct: 50,
    diagnosticCode: null,
    diagnosticMessage: null,
    ...rest,
  };
}

async function setUpNode(name: string, events: ReturnType<typeof envEvent>[]) {
  const registered = await registerOrRotateNode(prisma, { name, role: "greenhouse-node", rotateCredential: true });
  await ingestEnvironmentTelemetry(prisma, registered.node.id, parseEnvironmentBatch({ events }, new Date("2026-07-14T12:00:00.000Z")));
  return registered;
}

async function history(nodeName: string, query: string) {
  const response = await getMetricHistoryRoute(new Request(`http://localhost/api/nodes/${nodeName}/metrics/history?${query}`), {
    params: Promise.resolve({ nodeName }),
  });
  return { response, body: await response.json() };
}

describe("metric history API", () => {
  it("returns raw accepted temperature and humidity series for multiple sensors and metrics in stable time order", async () => {
    await setUpNode("greenhouse-history-raw", [
      envEvent({ eventId: "raw-outside-1", capturedAt: "2026-07-14T10:00:00.000Z", temperatureC: 20, humidityPct: 50 }),
      envEvent({ eventId: "raw-outside-2", capturedAt: "2026-07-14T10:10:00.000Z", temperatureC: 22, humidityPct: 52 }),
      envEvent({ eventId: "raw-bottom-1", sensor: { key: "greenhouse-bottom", name: "Bottom", gpio: 17, placement: "bottom", enabled: true }, capturedAt: "2026-07-14T10:05:00.000Z", temperatureC: 21, humidityPct: 55 }),
    ]);

    const { response, body } = await history(
      "greenhouse-history-raw",
      "sensorKeys=greenhouse-outside,greenhouse-bottom&metrics=temperatureC,humidityPct&from=2026-07-14T10:00:00.000Z&to=2026-07-14T10:15:00.000Z&resolution=raw",
    );

    expect(response.status).toBe(200);
    expect(body.range).toMatchObject({ resolution: "raw", timeZone: "America/New_York", bucketSemantics: "utc" });
    expect(body.series).toHaveLength(4);
    expect(body.series.find((series: { key: string }) => series.key === "greenhouse-outside:temperatureC").points).toEqual([
      { at: "2026-07-14T10:00:00.000Z", value: 20 },
      { at: "2026-07-14T10:10:00.000Z", value: 22 },
    ]);
    expect(body.series.find((series: { key: string }) => series.key === "greenhouse-bottom:humidityPct").points).toEqual([
      { at: "2026-07-14T10:05:00.000Z", value: 55 },
    ]);
  });

  it("excludes rejected and failed diagnostics from numeric series", async () => {
    await setUpNode("greenhouse-history-diagnostics", [
      envEvent({ eventId: "diag-good", capturedAt: "2026-07-14T10:00:00.000Z", temperatureC: 20, humidityPct: 50 }),
      envEvent({ eventId: "diag-rejected", capturedAt: "2026-07-14T10:05:00.000Z", classification: "rejected", temperatureC: 60, humidityPct: 50, diagnosticCode: "temperature-plausible-bound", diagnosticMessage: "too hot" }),
      envEvent({ eventId: "diag-failed", capturedAt: "2026-07-14T10:10:00.000Z", classification: "failed", temperatureC: null, humidityPct: null, diagnosticCode: "sensor-no-response", diagnosticMessage: "no response" }),
    ]);

    const { body } = await history(
      "greenhouse-history-diagnostics",
      "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-07-14T10:00:00.000Z&to=2026-07-14T10:15:00.000Z&resolution=raw",
    );

    expect(body.series[0].points).toEqual([{ at: "2026-07-14T10:00:00.000Z", value: 20 }]);
  });

  it("leaves missing periods missing rather than fabricating raw points", async () => {
    await setUpNode("greenhouse-history-gaps", [
      envEvent({ eventId: "gap-1", capturedAt: "2026-07-14T10:00:00.000Z", temperatureC: 20 }),
      envEvent({ eventId: "gap-2", capturedAt: "2026-07-14T10:20:00.000Z", temperatureC: 24 }),
    ]);

    const { body } = await history(
      "greenhouse-history-gaps",
      "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-07-14T10:00:00.000Z&to=2026-07-14T10:30:00.000Z&resolution=raw",
    );

    expect(body.series[0].points.map((point: { at: string }) => point.at)).toEqual(["2026-07-14T10:00:00.000Z", "2026-07-14T10:20:00.000Z"]);
  });

  it("aggregates five-minute buckets with count, min, max, mean, first, and last", async () => {
    await setUpNode("greenhouse-history-5m", [
      envEvent({ eventId: "bucket-5m-1", capturedAt: "2026-07-14T10:00:10.000Z", temperatureC: 20 }),
      envEvent({ eventId: "bucket-5m-2", capturedAt: "2026-07-14T10:04:50.000Z", temperatureC: 24 }),
      envEvent({ eventId: "bucket-5m-3", capturedAt: "2026-07-14T10:05:00.000Z", temperatureC: 30 }),
    ]);

    const { body } = await history(
      "greenhouse-history-5m",
      "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-07-14T10:00:00.000Z&to=2026-07-14T10:10:00.000Z&resolution=5m",
    );

    expect(body.series[0].points[0]).toMatchObject({ at: "2026-07-14T10:00:00.000Z", value: 22, count: 2, min: 20, max: 24, mean: 22, first: 20, last: 24 });
    expect(body.series[0].points[1]).toMatchObject({ at: "2026-07-14T10:05:00.000Z", value: 30, count: 1, min: 30, max: 30, mean: 30, first: 30, last: 30 });
  });

  it("aggregates fifteen-minute and hourly buckets deterministically on UTC boundaries", async () => {
    await setUpNode("greenhouse-history-buckets", [
      envEvent({ eventId: "bucket-1", capturedAt: "2026-07-14T10:00:00.000Z", temperatureC: 20 }),
      envEvent({ eventId: "bucket-2", capturedAt: "2026-07-14T10:10:00.000Z", temperatureC: 22 }),
      envEvent({ eventId: "bucket-3", capturedAt: "2026-07-14T10:45:00.000Z", temperatureC: 28 }),
    ]);

    const fifteen = await history(
      "greenhouse-history-buckets",
      "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-07-14T10:00:00.000Z&to=2026-07-14T11:00:00.000Z&resolution=15m",
    );
    expect(fifteen.body.series[0].points.map((point: { at: string; count: number }) => [point.at, point.count])).toEqual([
      ["2026-07-14T10:00:00.000Z", 2],
      ["2026-07-14T10:45:00.000Z", 1],
    ]);

    const hourly = await history(
      "greenhouse-history-buckets",
      "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-07-14T10:00:00.000Z&to=2026-07-14T11:00:00.000Z&resolution=1h",
    );
    expect(hourly.body.series[0].points[0]).toMatchObject({ at: "2026-07-14T10:00:00.000Z", count: 3, min: 20, max: 28, mean: 70 / 3, first: 20, last: 28 });
  });

  it("documents and supports historical removed sensor queries when the sensor row still exists", async () => {
    await setUpNode("greenhouse-history-removed", [
      envEvent({ eventId: "removed-1", sensor: { key: "greenhouse-retired", name: "Retired", gpio: 22, placement: null, enabled: false }, capturedAt: "2026-07-14T10:00:00.000Z", temperatureC: 19 }),
    ]);

    const { response, body } = await history(
      "greenhouse-history-removed",
      "sensorKeys=greenhouse-retired&metrics=temperatureC&from=2026-07-14T09:00:00.000Z&to=2026-07-14T11:00:00.000Z&resolution=raw",
    );

    expect(response.status).toBe(200);
    expect(body.series[0]).toMatchObject({ subjectKey: "greenhouse-retired", metric: "temperatureC" });
    expect(body.series[0].points).toEqual([{ at: "2026-07-14T10:00:00.000Z", value: 19 }]);
  });

  it("rejects invalid sensor keys, metrics, timestamp ranges, excessive ranges, and unknown nodes clearly", async () => {
    await setUpNode("greenhouse-history-invalid", [envEvent({ eventId: "invalid-base" })]);

    expect((await history("does-not-exist", "sensorKeys=greenhouse-outside&metrics=temperatureC")).response.status).toBe(404);
    expect((await history("greenhouse-history-invalid", "sensorKeys=missing&metrics=temperatureC")).response.status).toBe(400);
    expect((await history("greenhouse-history-invalid", "sensorKeys=greenhouse-outside&metrics=pressureKpa")).response.status).toBe(400);
    expect((await history("greenhouse-history-invalid", "sensorKeys=greenhouse-outside&metrics=temperatureC&from=not-a-date&to=2026-07-14T10:00:00.000Z")).response.status).toBe(400);
    expect((await history("greenhouse-history-invalid", "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-07-14T11:00:00.000Z&to=2026-07-14T10:00:00.000Z")).response.status).toBe(400);
    expect((await history("greenhouse-history-invalid", "sensorKeys=greenhouse-outside&metrics=temperatureC&from=2026-06-01T00:00:00.000Z&to=2026-07-14T00:00:00.000Z")).response.status).toBe(400);
  });
});
