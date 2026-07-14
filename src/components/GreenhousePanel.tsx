"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import {
  ACTIVE_GREENHOUSE_SENSORS,
  celsiusToFahrenheit,
  countSensorsNeedingAttention,
  filterActiveSensors,
  formatAge,
  sensorStatusTone,
  summarizeEnvironment,
  SENSOR_STATUS_LABEL,
  type EnvironmentSensor,
} from "@/lib/greenhouseDisplay";
import { guidanceForCode } from "@/lib/sensorDiagnostics";
import { GreenhouseCharts } from "./GreenhouseCharts";
import { PowerControlPanel } from "./PowerControlPanel";

const TONE_STYLES: Record<string, string> = {
  fresh: "bg-emerald-100 text-emerald-900 border-emerald-200",
  stale: "bg-amber-100 text-amber-900 border-amber-200",
  rejected: "bg-red-100 text-red-900 border-red-200",
  failed: "bg-red-100 text-red-900 border-red-200",
  unavailable: "bg-stone-100 text-stone-700 border-stone-200",
};

const POLL_INTERVAL_MS = 60_000;

export function GreenhousePanel({ nodeName }: { nodeName: string }) {
  const [sensors, setSensors] = useState<EnvironmentSensor[] | null>(null);
  const [nodeMissing, setNodeMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const envRes = await fetch(`/api/nodes/${nodeName}/environment`, { cache: "no-store" });

      if (envRes.status === 404) {
        setNodeMissing(true);
        return;
      }
      if (!envRes.ok) {
        setLoadError("Could not load greenhouse status from the coordinator.");
        return;
      }

      const env = await envRes.json();
      setNodeMissing(false);
      setLoadError(null);
      setSensors(env.sensors);
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  if (nodeMissing) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-600">
        Greenhouse node &ldquo;{nodeName}&rdquo; is not registered with the coordinator.
      </div>
    );
  }

  const activeSlots = filterActiveSensors(sensors ?? []);
  const summary = summarizeEnvironment(activeSlots);
  const loading = sensors === null && !loadError;
  const attentionCount = sensors ? countSensorsNeedingAttention(activeSlots) : 0;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-stone-950">
            <Link href={`/nodes/${nodeName}`} className="hover:underline">
              Greenhouse &mdash; {nodeName}
            </Link>
          </h2>
          {attentionCount > 0 ? (
            <span className="rounded-md border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
              {attentionCount} sensor{attentionCount === 1 ? "" : "s"} need{attentionCount === 1 ? "s" : ""} attention
            </span>
          ) : null}
        </div>
        {loading ? <span className="text-sm text-stone-600">Loading greenhouse status...</span> : null}
      </div>

      {loadError ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {activeSlots.map(({ key, label, sensor }) => {
          const tone = sensorStatusTone(sensor);
          const hasReading = sensor && tone === "fresh" && sensor.latestTemperatureC !== null && sensor.latestHumidityPct !== null;
          const guidance = tone !== "fresh" ? guidanceForCode(sensor?.lastDiagnosticCode) : null;

          return (
            <Link
              key={key}
              href={`/nodes/${nodeName}/sensors/${key}`}
              className="grid rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-300"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-stone-950">{label}</h3>
                  <p className="text-xs text-stone-500" aria-label={`Sensor ID ${key}`}>
                    {key}
                  </p>
                </div>
                <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>
                  {SENSOR_STATUS_LABEL[tone]}
                </span>
              </div>

              {hasReading ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-2xl font-semibold text-stone-950">
                      {celsiusToFahrenheit(sensor!.latestTemperatureC!).toFixed(1)}&deg;F
                    </p>
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
                Last accepted:{" "}
                {sensor?.lastAcceptedAt ? `${formatAge(sensor.lastAcceptedAt)} (${formatDateTime(sensor.lastAcceptedAt)})` : "never"}
              </p>

              {!hasReading ? <p className="mt-2 text-xs font-semibold text-emerald-700">View diagnostics &rarr;</p> : null}
            </Link>
          );
        })}
      </div>

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

      {sensors ? <GreenhouseCharts nodeName={nodeName} sensors={sensors} /> : null}

      <PowerControlPanel nodeName={nodeName} />
    </div>
  );
}

// Re-exported so tests/consumers don't need to duplicate the active sensor list.
export { ACTIVE_GREENHOUSE_SENSORS };
