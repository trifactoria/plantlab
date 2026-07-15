"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { celsiusToFahrenheit, formatAge, sensorStatusTone, SENSOR_STATUS_LABEL, SENSOR_STATUS_TONE_STYLES } from "@/lib/greenhouseDisplay";
import { DEFAULT_HISTORY_RANGE, fetchMetricHistory, type HistoryRangeValue, type NormalizedSeries } from "@/lib/metricHistory";
import { guidanceForCode, intermittentFailureSummary } from "@/lib/sensorDiagnostics";
import { RangeSelector } from "./charts/RangeSelector";
import { TimeSeriesCard } from "./charts/TimeSeriesCard";

type SensorEvent = {
  kind: "accepted" | "diagnostic";
  capturedAt: string;
  classification: string;
  temperatureC: number | null;
  humidityPct: number | null;
  code: string | null;
  message: string | null;
  attemptNumber: number | null;
  driver: string | null;
  gpio: number | null;
  durationMs: number | null;
};

type SensorDetail = {
  key: string;
  name: string;
  type: string;
  gpio: number | null;
  placement: string | null;
  enabled: boolean;
  latestClassification: string | null;
  latestTemperatureC: number | null;
  latestHumidityPct: number | null;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  stale: boolean;
  consecutiveFailures: number;
  consecutiveRejects: number;
  lastDiagnosticCode: string | null;
  lastDiagnosticMessage: string | null;
  firstSeenAt: string;
};

type TestAttempt = {
  attempt: number;
  classification: string;
  code: string | null;
  message: string | null;
  temperatureC: number | null;
  humidityPct: number | null;
};

type SensorTest = {
  id: string;
  sensorKey: string;
  status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "expired" | "cancelled";
  attemptsRequested: number;
  intervalSeconds: number;
  requestedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  attemptsCompleted: number | null;
  acceptedCount: number | null;
  failedCount: number | null;
  finalPass: boolean | null;
  effectiveDriver: string | null;
  configuredGpio: number | null;
  attempts: TestAttempt[];
  errorCode: string | null;
  errorMessage: string | null;
};

type SensorDetailResponse = {
  sensor: SensorDetail;
  events: SensorEvent[];
  activeTest: SensorTest | null;
  recentTests: SensorTest[];
};

const TEST_STATUS_LABEL: Record<SensorTest["status"], string> = {
  pending: "Queued",
  claimed: "Claimed",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
};

const TEST_STATUS_TONE: Record<SensorTest["status"], string> = {
  pending: "border-amber-200 bg-amber-100 text-amber-900",
  claimed: "border-amber-200 bg-amber-100 text-amber-900",
  running: "border-amber-200 bg-amber-100 text-amber-900",
  succeeded: "border-emerald-200 bg-emerald-100 text-emerald-900",
  failed: "border-red-200 bg-red-100 text-red-900",
  expired: "border-red-200 bg-red-100 text-red-900",
  cancelled: "border-stone-200 bg-stone-100 text-stone-700",
};

const NORMAL_POLL_MS = 30_000;
const ACTIVE_TEST_POLL_MS = 3_000;

export function SensorDetailPanel({ nodeName, sensorKey }: { nodeName: string; sensorKey: string }) {
  const [data, setData] = useState<SensorDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const hasActiveTestRef = useRef(false);

  const [chartRange, setChartRange] = useState<HistoryRangeValue>(DEFAULT_HISTORY_RANGE);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [temperatureSeries, setTemperatureSeries] = useState<NormalizedSeries[]>([]);
  const [humiditySeries, setHumiditySeries] = useState<NormalizedSeries[]>([]);
  const chartLoadedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setChartLoading(true);
    setChartError(null);
    fetchMetricHistory({ nodeName, sensorKeys: [sensorKey], metrics: ["temperatureC", "humidityPct"], range: chartRange }).then((result) => {
      if (cancelled) return;
      chartLoadedOnce.current = true;
      if (!result.ok) {
        setChartError(result.error);
        setChartLoading(false);
        return;
      }
      setTemperatureSeries(
        (result.seriesByMetric.temperatureC ?? []).map((series) => ({
          ...series,
          unit: "fahrenheit",
          points: series.points.map((point) => ({ at: point.at, value: point.value === null ? null : celsiusToFahrenheit(point.value) })),
        })),
      );
      setHumiditySeries(result.seriesByMetric.humidityPct ?? []);
      setChartLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [nodeName, sensorKey, chartRange]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/nodes/${nodeName}/sensors/${sensorKey}`, { cache: "no-store" });
      if (!response.ok) {
        setLoadError(response.status === 404 ? "Sensor not found." : "Could not load sensor detail.");
        return;
      }
      setLoadError(null);
      const body = (await response.json()) as SensorDetailResponse;
      hasActiveTestRef.current = body.activeTest !== null;
      setData(body);
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName, sensorKey]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number;

    function scheduleNext() {
      const interval = hasActiveTestRef.current ? ACTIVE_TEST_POLL_MS : NORMAL_POLL_MS;
      timeoutId = window.setTimeout(async () => {
        if (cancelled) return;
        await load();
        if (!cancelled) scheduleNext();
      }, interval);
    }

    void load();
    scheduleNext();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [load]);

  async function runTest() {
    setTestBusy(true);
    setTestMessage(null);
    try {
      const response = await fetch(`/api/nodes/${nodeName}/sensors/${sensorKey}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTestMessage(body.error ?? "Could not start sensor test.");
      } else {
        setTestMessage(null);
      }
    } catch {
      setTestMessage("Could not reach the coordinator.");
    } finally {
      setTestBusy(false);
      await load();
    }
  }

  if (loadError && !data) {
    return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>;
  }
  if (!data) {
    return <p className="text-sm text-stone-600">Loading sensor detail...</p>;
  }

  const { sensor, events, activeTest, recentTests } = data;
  const tone = sensorStatusTone(sensor.enabled ? sensor : null);
  const guidance = tone !== "fresh" ? guidanceForCode(sensor.lastDiagnosticCode) : null;

  const recentOutcomes = events
    .slice(0, 10)
    .map((event): "accepted" | "failed" | "rejected" => (event.kind === "accepted" ? "accepted" : event.classification === "rejected" || event.classification === "suspect" ? "rejected" : "failed"));
  const intermittent = intermittentFailureSummary(recentOutcomes);

  const activeOrLatestTest = activeTest ?? recentTests[0] ?? null;
  const testDisabled = testBusy || activeTest !== null;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-950">{sensor.name}</h2>
            <p className="text-xs text-stone-500">{sensor.key}</p>
          </div>
          <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${SENSOR_STATUS_TONE_STYLES[tone]}`}>{SENSOR_STATUS_LABEL[tone]}</span>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Type" value={sensor.type} />
          <Field label="Configured BCM GPIO" value={sensor.gpio !== null ? String(sensor.gpio) : "unknown"} />
          <Field label="Placement" value={sensor.placement ?? "(none)"} />
          <Field label="Enabled" value={sensor.enabled ? "yes" : "no"} />
          <Field label="Effective driver" value={activeOrLatestTest?.effectiveDriver ?? "pigpio"} />
          <Field label="Classification" value={sensor.latestClassification ?? "never reported"} />
          <Field label="Consecutive failures" value={String(sensor.consecutiveFailures)} />
          <Field label="Consecutive rejects" value={String(sensor.consecutiveRejects)} />
          <Field label="Last attempt" value={sensor.lastAttemptAt ? `${formatAge(sensor.lastAttemptAt)} (${formatDateTime(sensor.lastAttemptAt)})` : "never"} />
          <Field label="Last success" value={sensor.lastAcceptedAt ? `${formatAge(sensor.lastAcceptedAt)} (${formatDateTime(sensor.lastAcceptedAt)})` : "never"} />
          <Field label="Age since last valid reading" value={sensor.lastAcceptedAt ? formatAge(sensor.lastAcceptedAt) : "never valid"} />
          <Field label="First seen" value={formatDateTime(sensor.firstSeenAt)} />
        </dl>

        {tone === "fresh" && sensor.latestTemperatureC !== null && sensor.latestHumidityPct !== null ? (
          <div className="mt-4 grid grid-cols-2 gap-3 rounded-md border border-stone-200 bg-stone-50 p-3 sm:w-80">
            <div>
              <p className="text-2xl font-semibold text-stone-950">{celsiusToFahrenheit(sensor.latestTemperatureC).toFixed(1)}&deg;F</p>
              <p className="text-xs text-stone-500">{sensor.latestTemperatureC.toFixed(1)}&deg;C</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-stone-950">{sensor.latestHumidityPct.toFixed(0)}%</p>
              <p className="text-xs text-stone-500">Relative humidity</p>
            </div>
          </div>
        ) : null}

        {sensor.lastDiagnosticCode ? (
          <p className="mt-4 text-sm text-stone-700">
            <span className="font-medium">Last diagnostic:</span> {sensor.lastDiagnosticCode} - {sensor.lastDiagnosticMessage}
          </p>
        ) : null}
      </div>

      {guidance ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <h3 className="font-semibold text-amber-900">{guidance.label} - likely causes</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {guidance.likelyCauses.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
          {recentOutcomes.length >= 3 ? (
            <p className="mt-3 text-sm text-amber-900">
              {intermittent.isTotalFailure
                ? `No successful reads in the last ${recentOutcomes.length} events (0% success rate) - treat as a total failure, not noise.`
                : intermittent.isIntermittent
                  ? `${intermittent.successRatePct}% success rate over the last ${recentOutcomes.length} events - this looks intermittent rather than a total failure.`
                  : "Recent events have been successful."}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-stone-950">Sensor test</h3>
          <button type="button" className="button" disabled={testDisabled} onClick={runTest}>
            {activeTest ? "Test in progress..." : testBusy ? "Starting..." : "Run sensor test"}
          </button>
        </div>
        {testMessage ? <p className="mt-2 text-sm text-red-700">{testMessage}</p> : null}

        {activeOrLatestTest ? (
          <div className="mt-3 rounded-md border border-stone-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${TEST_STATUS_TONE[activeOrLatestTest.status]}`}>{TEST_STATUS_LABEL[activeOrLatestTest.status]}</span>
              <span className="text-xs text-stone-500">
                Requested {formatAge(activeOrLatestTest.requestedAt)} &middot; {activeOrLatestTest.attemptsRequested} attempts, {activeOrLatestTest.intervalSeconds}s interval
              </span>
            </div>
            {activeOrLatestTest.claimedAt ? <p className="mt-2 text-xs text-stone-600">Claimed: {formatDateTime(activeOrLatestTest.claimedAt)}</p> : null}
            {activeOrLatestTest.completedAt ? <p className="text-xs text-stone-600">Completed: {formatDateTime(activeOrLatestTest.completedAt)}</p> : null}
            {activeOrLatestTest.errorMessage ? <p className="mt-2 text-sm text-red-700">{activeOrLatestTest.errorMessage}</p> : null}
            {activeOrLatestTest.attempts.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-stone-500">
                    <tr>
                      <th className="pr-3 py-1">Attempt</th>
                      <th className="pr-3 py-1">Result</th>
                      <th className="pr-3 py-1">Reading</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeOrLatestTest.attempts.map((attempt) => (
                      <tr key={attempt.attempt} className="border-t border-stone-100">
                        <td className="pr-3 py-1">{attempt.attempt}</td>
                        <td className="pr-3 py-1">
                          {attempt.classification}
                          {attempt.code ? ` (${attempt.code})` : ""}
                        </td>
                        <td className="pr-3 py-1">{attempt.temperatureC !== null && attempt.humidityPct !== null ? `${attempt.temperatureC.toFixed(1)}C / ${attempt.humidityPct.toFixed(1)}%` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-stone-600">No tests run yet.</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="flex items-center justify-end">
          <RangeSelector value={chartRange} onChange={setChartRange} label="History range" />
        </div>
        <TimeSeriesCard
          title="Temperature history"
          unit="°F"
          series={temperatureSeries}
          range={chartRange}
          showRangeSelector={false}
          loading={chartLoading && !chartLoadedOnce.current}
          error={chartError}
          emptyMessage="No temperature history yet for this range."
        />
        <TimeSeriesCard
          title="Humidity history"
          unit="%"
          series={humiditySeries}
          range={chartRange}
          showRangeSelector={false}
          loading={chartLoading && !chartLoadedOnce.current}
          error={chartError}
          emptyMessage="No humidity history yet for this range."
        />
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold text-stone-950">Recent event history</h3>
        <div className="mt-3 overflow-x-auto rounded-md border border-stone-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-stone-50 text-xs font-semibold uppercase text-stone-600">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Classification</th>
                <th className="px-3 py-2">Reading</th>
                <th className="px-3 py-2">Diagnostic</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-stone-600" colSpan={4}>
                    No events yet.
                  </td>
                </tr>
              ) : (
                events.map((event, index) => (
                  <tr key={`${event.capturedAt}-${index}`} className="border-t border-stone-100">
                    <td className="px-3 py-2 text-stone-600">{formatDateTime(event.capturedAt)}</td>
                    <td className="px-3 py-2 text-stone-600">{event.classification}</td>
                    <td className="px-3 py-2 text-stone-600">{event.temperatureC !== null && event.humidityPct !== null ? `${event.temperatureC.toFixed(1)}C / ${event.humidityPct.toFixed(1)}%` : "-"}</td>
                    <td className="px-3 py-2 text-stone-600">{event.code ? `${event.code}${event.message ? `: ${event.message}` : ""}` : "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-stone-950">{label}</dt>
      <dd className="text-stone-600">{value}</dd>
    </div>
  );
}
