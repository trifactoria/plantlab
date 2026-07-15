"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import {
  celsiusToFahrenheit,
  countSensorsNeedingAttention,
  formatAge,
  sensorStatusTone,
  summarizeEnvironment,
  SENSOR_STATUS_LABEL,
  type ActiveSensorSlot,
  type EnvironmentSensor,
} from "@/lib/greenhouseDisplay";
import { guidanceForCode } from "@/lib/sensorDiagnostics";
import {
  DEFAULT_HISTORY_RANGE,
  fetchMetricHistory,
  rangeDefinition,
  type HistoryRangeValue,
  type NormalizedSeries,
} from "@/lib/metricHistory";
import { fetchPowerHistory, type NormalizedPowerTrack } from "@/lib/powerHistoryClient";
import { MetricTimelineCard } from "@/components/charts/MetricTimelineCard";
import { RangeSelector } from "@/components/charts/RangeSelector";
import { StatusBadge } from "@/components/shell/StatusBadge";

type EnvSensor = EnvironmentSensor & { name: string };

function toFahrenheit(series: NormalizedSeries[]): NormalizedSeries[] {
  return series.map((item) => ({
    ...item,
    unit: "fahrenheit",
    points: item.points.map((point) => ({ at: point.at, value: point.value === null ? null : celsiusToFahrenheit(point.value) })),
  }));
}

function relabel(series: NormalizedSeries[], labelBySubject: Map<string, string>): NormalizedSeries[] {
  return series.map((item) => ({ ...item, label: labelBySubject.get(item.subjectKey) ?? item.label }));
}

const TONE_FOR_STATUS = {
  fresh: "ok",
  stale: "warn",
  rejected: "bad",
  failed: "bad",
  unavailable: "neutral",
} as const;

const POLL_INTERVAL_MS = 60_000;

/**
 * One node's environment surface for the dashboard Environment tab: live
 * sensor cards, an environmental summary, and temperature/humidity history
 * with the node's power state overlaid on the same timeline. Unlike the
 * node-detail GreenhousePanel it does not embed power controls (those live in
 * the Power tab) and it is not limited to the four hardcoded greenhouse
 * slots - it renders whatever active sensors the environment API returns.
 */
export function EnvironmentNodePanel({ nodeName, hasOutlets }: { nodeName: string; hasOutlets: boolean }) {
  const [sensors, setSensors] = useState<EnvSensor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [range, setRange] = useState<HistoryRangeValue>(DEFAULT_HISTORY_RANGE);
  const [temperature, setTemperature] = useState<NormalizedSeries[]>([]);
  const [humidity, setHumidity] = useState<NormalizedSeries[]>([]);
  const [powerTracks, setPowerTracks] = useState<NormalizedPowerTrack[]>([]);
  const [rangeBounds, setRangeBounds] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const hasLoadedChart = useRef(false);

  const loadSensors = useCallback(async () => {
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(nodeName)}/environment`, { cache: "no-store" });
      if (!res.ok) {
        setLoadError("Could not load environment status from the coordinator.");
        return;
      }
      const env = await res.json();
      setLoadError(null);
      setSensors(env.sensors ?? []);
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName]);

  useEffect(() => {
    void loadSensors();
    const interval = window.setInterval(() => void loadSensors(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadSensors]);

  const slots: ActiveSensorSlot<EnvSensor>[] = useMemo(
    () => (sensors ?? []).map((sensor) => ({ key: sensor.key, label: sensor.name, sensor })),
    [sensors],
  );
  const sensorKeys = useMemo(() => slots.map((slot) => slot.key).sort(), [slots]);
  const sensorKeysSignature = sensorKeys.join(",");
  const labelBySubject = useMemo(() => new Map(slots.map((slot) => [slot.key, slot.label])), [slots]);

  useEffect(() => {
    let cancelled = false;
    if (sensorKeys.length === 0) {
      setTemperature([]);
      setHumidity([]);
      setPowerTracks([]);
      setChartLoading(false);
      return;
    }

    const now = new Date();
    const definition = rangeDefinition(range);
    const from = new Date(now.getTime() - definition.durationMs);
    setRangeBounds({ from: from.getTime(), to: now.getTime() });
    setChartLoading(true);
    setChartError(null);

    Promise.all([
      fetchMetricHistory({ nodeName, sensorKeys, metrics: ["temperatureC", "humidityPct"], range, now }),
      hasOutlets ? fetchPowerHistory({ nodeName, from: from.getTime(), to: now.getTime() }) : Promise.resolve(null),
    ]).then(([metrics, power]) => {
      if (cancelled) return;
      hasLoadedChart.current = true;
      if (!metrics.ok) {
        setChartError(metrics.error);
        setChartLoading(false);
        return;
      }
      setTemperature(toFahrenheit(relabel(metrics.seriesByMetric.temperatureC ?? [], labelBySubject)));
      setHumidity(relabel(metrics.seriesByMetric.humidityPct ?? [], labelBySubject));
      setPowerTracks(power && power.ok ? power.tracks : []);
      setChartLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeName, range, sensorKeysSignature, hasOutlets]);

  const summary = summarizeEnvironment(slots);
  const attentionCount = sensors ? countSensorsNeedingAttention(slots) : 0;
  const loading = sensors === null && !loadError;
  const showChartLoading = chartLoading && !hasLoadedChart.current;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-stone-950">
            <Link href={`/nodes/${encodeURIComponent(nodeName)}`} className="hover:underline">
              {nodeName}
            </Link>
          </h2>
          {attentionCount > 0 ? (
            <StatusBadge tone="warn">
              {attentionCount} sensor{attentionCount === 1 ? "" : "s"} need{attentionCount === 1 ? "s" : ""} attention
            </StatusBadge>
          ) : null}
        </div>
        {loading ? <span className="text-sm text-stone-600">Loading environment...</span> : null}
      </div>

      {loadError ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p> : null}

      {slots.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {slots.map(({ key, label, sensor }) => {
            const tone = sensorStatusTone(sensor);
            const hasReading = sensor && tone === "fresh" && sensor.latestTemperatureC !== null && sensor.latestHumidityPct !== null;
            const guidance = tone !== "fresh" ? guidanceForCode(sensor?.lastDiagnosticCode) : null;
            return (
              <Link
                key={key}
                href={`/nodes/${encodeURIComponent(nodeName)}/sensors/${key}`}
                className="grid rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-300"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-stone-950">{label}</h3>
                    <p className="text-xs text-stone-500">{key}</p>
                  </div>
                  <StatusBadge tone={TONE_FOR_STATUS[tone]}>{SENSOR_STATUS_LABEL[tone]}</StatusBadge>
                </div>
                {hasReading ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-2xl font-semibold text-stone-950">{celsiusToFahrenheit(sensor!.latestTemperatureC!).toFixed(1)}&deg;F</p>
                      <p className="text-xs text-stone-500">{sensor!.latestTemperatureC!.toFixed(1)}&deg;C</p>
                    </div>
                    <div>
                      <p className="text-2xl font-semibold text-stone-950">{sensor!.latestHumidityPct!.toFixed(0)}%</p>
                      <p className="text-xs text-stone-500">Relative humidity</p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-stone-600">
                    <p>{tone === "unavailable" ? "No data received yet." : guidance?.label ?? `No valid reading (${SENSOR_STATUS_LABEL[tone].toLowerCase()}).`}</p>
                    {sensor?.lastDiagnosticMessage ? <p className="mt-1 text-xs text-stone-500">{sensor.lastDiagnosticMessage}</p> : null}
                  </div>
                )}
                <p className="mt-3 text-xs text-stone-500">
                  Last accepted: {sensor?.lastAcceptedAt ? `${formatAge(sensor.lastAcceptedAt)} (${formatDateTime(sensor.lastAcceptedAt)})` : "never"}
                </p>
              </Link>
            );
          })}
        </div>
      ) : null}

      {slots.length > 0 ? (
        <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold text-stone-950">Environmental summary</h3>
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <dt className="font-medium text-stone-950">Hottest</dt>
              <dd className="text-stone-600">{summary.hottest ? `${summary.hottest.fahrenheit.toFixed(1)}°F (${summary.hottest.label})` : "-"}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Coolest</dt>
              <dd className="text-stone-600">{summary.coolest ? `${summary.coolest.fahrenheit.toFixed(1)}°F (${summary.coolest.label})` : "-"}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Highest humidity</dt>
              <dd className="text-stone-600">{summary.highestHumidity ? `${summary.highestHumidity.pct.toFixed(0)}% (${summary.highestHumidity.label})` : "-"}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Lowest humidity</dt>
              <dd className="text-stone-600">{summary.lowestHumidity ? `${summary.lowestHumidity.pct.toFixed(0)}% (${summary.lowestHumidity.label})` : "-"}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Latest update</dt>
              <dd className="text-stone-600">{formatAge(summary.latestUpdateAt)}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {slots.length > 0 ? (
        <>
          <div className="flex items-center justify-end">
            <RangeSelector value={range} onChange={setRange} label="Chart range" />
          </div>
          <MetricTimelineCard
            title="Temperature"
            unit="°F"
            series={temperature}
            rangeFrom={rangeBounds.from}
            rangeTo={rangeBounds.to}
            powerTracks={powerTracks}
            loading={showChartLoading}
            error={chartError}
            emptyMessage="No temperature history yet for this range."
          />
          <MetricTimelineCard
            title="Relative humidity"
            unit="%"
            series={humidity}
            rangeFrom={rangeBounds.from}
            rangeTo={rangeBounds.to}
            powerTracks={powerTracks}
            loading={showChartLoading}
            error={chartError}
            emptyMessage="No humidity history yet for this range."
          />
        </>
      ) : null}
    </div>
  );
}
