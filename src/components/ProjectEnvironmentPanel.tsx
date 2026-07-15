"use client";

import { useEffect, useMemo, useState } from "react";
import { celsiusToFahrenheit, sensorStatusTone, SENSOR_STATUS_LABEL, SENSOR_STATUS_TONE_STYLES } from "@/lib/greenhouseDisplay";
import { DEFAULT_HISTORY_RANGE, fetchProjectMetricHistory, type HistoryRangeValue, type NormalizedSeries } from "@/lib/metricHistory";
import { RangeSelector } from "./charts/RangeSelector";
import { TimeSeriesCard } from "./charts/TimeSeriesCard";

export type ProjectSensorBindingView = {
  id: string;
  enabled: boolean;
  label: string | null;
  role: string;
  degraded: boolean;
  node: { id: string; name: string; role: string };
  sensor: {
    id: string;
    key: string;
    name: string;
    lastAttemptAt: string | null;
    lastAcceptedAt: string | null;
    latestClassification: string | null;
    latestTemperatureC: number | null;
    latestHumidityPct: number | null;
  };
};

function toFahrenheit(series: NormalizedSeries[]): NormalizedSeries[] {
  return series.map((item) => ({
    ...item,
    unit: "fahrenheit",
    points: item.points.map((point) => ({ at: point.at, value: point.value === null ? null : celsiusToFahrenheit(point.value) })),
  }));
}

/**
 * Project dashboard "Environment" section: the sensors linked to this
 * project with their current reading and freshness, plus temperature/
 * humidity history across every enabled linked sensor - reuses the same
 * generic TimeSeriesCard/MetricChart used by the node environment panel
 * (GreenhouseCharts.tsx), fed by the project-scoped metrics API instead of
 * a single node's.
 */
export function ProjectEnvironmentPanel({
  projectId,
  timeZone,
  bindings,
}: {
  projectId: string;
  timeZone: string;
  bindings: ProjectSensorBindingView[];
}) {
  const [range, setRange] = useState<HistoryRangeValue>(DEFAULT_HISTORY_RANGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [temperature, setTemperature] = useState<NormalizedSeries[]>([]);
  const [humidity, setHumidity] = useState<NormalizedSeries[]>([]);

  const bindingIds = useMemo(() => bindings.filter((binding) => binding.enabled).map((binding) => binding.id), [bindings]);
  const bindingIdsSignature = bindingIds.join(",");

  useEffect(() => {
    let cancelled = false;

    if (bindingIds.length === 0) {
      setTemperature([]);
      setHumidity([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchProjectMetricHistory({ projectId, bindingIds, metrics: ["temperatureC", "humidityPct"], range, timeZone }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setTemperature(toFahrenheit(result.seriesByMetric.temperatureC ?? []));
      setHumidity(result.seriesByMetric.humidityPct ?? []);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // bindingIdsSignature (not bindingIds) intentionally drives refetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, range, bindingIdsSignature, timeZone]);

  if (bindings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-600">
        No environmental sensors linked. Link sensors from Project Settings.
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="font-semibold text-stone-950">Linked Sensors</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {bindings.map((binding) => {
            const tone = sensorStatusTone(binding.enabled ? binding.sensor : null);
            const hasReading = binding.sensor.latestTemperatureC !== null && binding.sensor.latestHumidityPct !== null;
            return (
              <div key={binding.id} data-testid={`project-sensor-binding-${binding.id}`} className="rounded-md border border-stone-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-stone-950">{binding.label ?? binding.sensor.name}</p>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${SENSOR_STATUS_TONE_STYLES[tone]}`}>
                    {SENSOR_STATUS_LABEL[tone]}
                  </span>
                </div>
                <p className="text-xs text-stone-500">
                  {binding.node.name} &middot; {binding.role}
                  {!binding.enabled ? " · disabled" : ""}
                </p>
                <p className="mt-1 text-sm text-stone-700">
                  {hasReading
                    ? `${celsiusToFahrenheit(binding.sensor.latestTemperatureC as number).toFixed(1)}°F / ${(binding.sensor.latestHumidityPct as number).toFixed(0)}%`
                    : "No reading yet"}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end">
        <RangeSelector value={range} onChange={setRange} label="Chart range" />
      </div>
      <TimeSeriesCard
        title="Temperature"
        unit="°F"
        series={temperature}
        range={range}
        showRangeSelector={false}
        loading={loading}
        error={error}
        emptyMessage="No temperature history yet for this range."
      />
      <TimeSeriesCard
        title="Humidity"
        unit="%"
        series={humidity}
        range={range}
        showRangeSelector={false}
        loading={loading}
        error={error}
        emptyMessage="No humidity history yet for this range."
      />
    </div>
  );
}
