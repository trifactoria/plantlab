"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import {
  celsiusToFahrenheit,
  filterCurrentlyActiveSensors,
  formatAge,
  sensorStatusTone,
  SENSOR_STATUS_LABEL,
  type EnvironmentSensor,
} from "@/lib/greenhouseDisplay";

type NodeSensorRow = EnvironmentSensor & {
  name: string;
  type: string;
  gpio: number | null;
  placement: string | null;
  enabled: boolean;
};

const TONE_STYLES: Record<string, string> = {
  fresh: "border-emerald-200 bg-emerald-100 text-emerald-900",
  stale: "border-amber-200 bg-amber-100 text-amber-900",
  rejected: "border-red-200 bg-red-100 text-red-900",
  failed: "border-red-200 bg-red-100 text-red-900",
  unavailable: "border-stone-200 bg-stone-100 text-stone-700",
};

const POLL_INTERVAL_MS = 30_000;

/**
 * Read-only list of a node's currently-configured sensors: health, GPIO,
 * placement, last valid reading, and last diagnostic, each linking to its
 * detail page. See /nodes/[nodeName]/sensors.
 */
export function SensorListPanel({ nodeName }: { nodeName: string }) {
  const [sensors, setSensors] = useState<NodeSensorRow[] | null>(null);
  const [nodeMissing, setNodeMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/nodes/${nodeName}/environment`, { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 404) {
          setNodeMissing(true);
          return;
        }
        if (!response.ok) {
          setLoadError("Could not load sensor list from the coordinator.");
          return;
        }
        const body = await response.json();
        setLoadError(null);
        setSensors(body.sensors);
      } catch {
        if (!cancelled) setLoadError("Could not reach the coordinator.");
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [nodeName]);

  if (nodeMissing) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-600">
        Node &ldquo;{nodeName}&rdquo; is not registered with the coordinator.
      </div>
    );
  }
  if (loadError) {
    return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>;
  }
  if (sensors === null) {
    return <p className="text-sm text-stone-600">Loading sensors...</p>;
  }

  const activeSensors = filterCurrentlyActiveSensors(sensors);

  if (activeSensors.length === 0) {
    return <p className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-600">No currently-configured sensors reported for this node.</p>;
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs font-semibold uppercase text-stone-600">
            <tr>
              <th className="px-4 py-2">Sensor</th>
              <th className="px-4 py-2">Health</th>
              <th className="px-4 py-2">GPIO</th>
              <th className="px-4 py-2">Placement</th>
              <th className="px-4 py-2">Last valid reading</th>
              <th className="px-4 py-2">Last diagnostic</th>
            </tr>
          </thead>
          <tbody>
            {activeSensors.map((sensor) => {
              const tone = sensorStatusTone(sensor);
              const hasReading = sensor.latestTemperatureC !== null && sensor.latestHumidityPct !== null;
              return (
                <tr key={sensor.key} className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    <Link href={`/nodes/${nodeName}/sensors/${sensor.key}`} className="font-medium text-emerald-700 hover:underline">
                      {sensor.name}
                    </Link>
                    <p className="text-xs text-stone-500">{sensor.key}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>{SENSOR_STATUS_LABEL[tone]}</span>
                  </td>
                  <td className="px-4 py-3 text-stone-600">{sensor.gpio ?? "unknown"}</td>
                  <td className="px-4 py-3 text-stone-600">{sensor.placement ?? "(none)"}</td>
                  <td className="px-4 py-3 text-stone-600">
                    {hasReading ? (
                      <>
                        {celsiusToFahrenheit(sensor.latestTemperatureC!).toFixed(1)}&deg;F / {sensor.latestHumidityPct!.toFixed(0)}%
                        <p className="text-xs text-stone-500">{sensor.lastAcceptedAt ? formatAge(sensor.lastAcceptedAt) : "never"}</p>
                      </>
                    ) : (
                      <span className="text-stone-500">{sensor.lastAcceptedAt ? `${formatAge(sensor.lastAcceptedAt)} (stale)` : "never"}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {sensor.lastDiagnosticCode ? (
                      <>
                        <p>{sensor.lastDiagnosticCode}</p>
                        {sensor.lastDiagnosticMessage ? <p className="text-xs text-stone-500">{sensor.lastDiagnosticMessage}</p> : null}
                        {sensor.lastAttemptAt ? <p className="text-xs text-stone-500">{formatDateTime(sensor.lastAttemptAt)}</p> : null}
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
