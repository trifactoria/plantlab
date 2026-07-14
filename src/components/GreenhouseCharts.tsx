"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { celsiusToFahrenheit } from "@/lib/greenhouseDisplay";
import { DEFAULT_HISTORY_RANGE, fetchMetricHistory, type HistoryRangeValue, type NormalizedSeries } from "@/lib/metricHistory";
import { RangeSelector } from "./charts/RangeSelector";
import { TimeSeriesCard } from "./charts/TimeSeriesCard";

function relabelSeries(series: NormalizedSeries[], labelByKey: Map<string, string>): NormalizedSeries[] {
  return series.map((item) => ({ ...item, label: labelByKey.get(item.subjectKey) ?? item.label }));
}

function toFahrenheit(series: NormalizedSeries[]): NormalizedSeries[] {
  return series.map((item) => ({
    ...item,
    unit: "fahrenheit",
    points: item.points.map((point) => ({ at: point.at, value: point.value === null ? null : celsiusToFahrenheit(point.value) })),
  }));
}

/**
 * Node-level temperature/humidity history: one series per currently-enabled
 * sensor, sharing a single range selector. Driven entirely by the sensor
 * list the caller passes in (from the environment API) rather than a fixed
 * allowlist, so it keeps working if the configured sensor set changes.
 */
export function GreenhouseCharts({ nodeName, sensors }: { nodeName: string; sensors: Array<{ key: string; name?: string; enabled?: boolean }> }) {
  const [range, setRange] = useState<HistoryRangeValue>(DEFAULT_HISTORY_RANGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [temperature, setTemperature] = useState<NormalizedSeries[]>([]);
  const [humidity, setHumidity] = useState<NormalizedSeries[]>([]);
  const hasLoadedOnce = useRef(false);

  const activeSensorKeys = useMemo(
    () =>
      sensors
        .filter((sensor) => sensor.enabled !== false)
        .map((sensor) => sensor.key)
        .sort(),
    [sensors],
  );
  const labelByKey = useMemo(() => new Map(sensors.map((sensor) => [sensor.key, sensor.name ?? sensor.key])), [sensors]);
  const sensorKeysSignature = activeSensorKeys.join(",");

  useEffect(() => {
    let cancelled = false;

    if (activeSensorKeys.length === 0) {
      setTemperature([]);
      setHumidity([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchMetricHistory({ nodeName, sensorKeys: activeSensorKeys, metrics: ["temperatureC", "humidityPct"], range }).then((result) => {
      if (cancelled) return;
      hasLoadedOnce.current = true;
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setTemperature(toFahrenheit(relabelSeries(result.seriesByMetric.temperatureC ?? [], labelByKey)));
      setHumidity(relabelSeries(result.seriesByMetric.humidityPct ?? [], labelByKey));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // sensorKeysSignature (not activeSensorKeys) intentionally drives refetching - the array
    // reference changes every parent poll even when its contents don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeName, range, sensorKeysSignature]);

  // Only show the full-card loading state on the very first fetch - a
  // background refresh (parent re-polls every ~60s) should update the
  // chart in place rather than blanking it out each time.
  const showLoading = loading && !hasLoadedOnce.current;

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex items-center justify-end">
        <RangeSelector value={range} onChange={setRange} label="Chart range" />
      </div>
      <TimeSeriesCard
        title="Temperature across sensors"
        unit="°F"
        series={temperature}
        range={range}
        showRangeSelector={false}
        loading={showLoading}
        error={error}
        emptyMessage="No temperature history yet for this range."
      />
      <TimeSeriesCard
        title="Relative humidity across sensors"
        unit="%"
        series={humidity}
        range={range}
        showRangeSelector={false}
        loading={showLoading}
        error={error}
        emptyMessage="No humidity history yet for this range."
      />
    </div>
  );
}
