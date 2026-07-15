"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";
import { formatAge } from "@/lib/greenhouseDisplay";
import { cameraStatusTone, StatusBadge } from "@/components/shell/StatusBadge";
import { EmptyState } from "@/components/shell/SummaryCard";

const STATUS_LABELS: Record<FleetCameraSummary["status"], string> = {
  available: "Available",
  unavailable: "Unavailable",
  disabled: "Disabled",
  retired: "Retired",
  "node-offline": "Node offline",
};

/**
 * Cameras tab body: fleet-wide camera overview from the canonical
 * GET /api/hardware/cameras catalog, grouped by node. Coordinator-local,
 * standalone-local, and attached-node cameras are shown identically - local
 * versus remote only affects where capture executes, not how the fleet reads.
 * This is a dashboard surface only; configuration lives on the camera pages.
 */
export function FleetCameraDashboard() {
  const [cameras, setCameras] = useState<FleetCameraSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/hardware/cameras", { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        const body = await res.json();
        if (!cancelled) {
          setCameras(body.cameras ?? []);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not load fleet cameras.");
      }
    }
    void load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (error && !cameras) return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p>;
  if (!cameras) return <p className="text-sm text-stone-600">Loading fleet cameras...</p>;
  if (cameras.length === 0) {
    return <EmptyState message="No cameras have been discovered on this installation or any attached node yet." />;
  }

  const byNode = new Map<string, FleetCameraSummary[]>();
  for (const camera of cameras) {
    const key = camera.node.name;
    if (!byNode.has(key)) byNode.set(key, []);
    byNode.get(key)!.push(camera);
  }

  return (
    <div className="grid gap-6">
      {[...byNode.entries()].map(([nodeName, nodeCameras]) => (
        <div key={nodeName} className="grid gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-stone-950">{nodeName}</h2>
            {!nodeCameras[0].node.online ? <StatusBadge tone="neutral">offline</StatusBadge> : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {nodeCameras.map((camera) => (
              <Link
                key={camera.id}
                href={camera.detailsUrl}
                className="grid content-start gap-2 rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-300"
                data-testid={`fleet-camera-${camera.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-stone-950">{camera.displayName}</h3>
                    {camera.reportedName && camera.reportedName !== camera.displayName ? (
                      <p className="truncate text-xs text-stone-400">{camera.reportedName}</p>
                    ) : null}
                  </div>
                  <StatusBadge tone={cameraStatusTone(camera.status)}>{STATUS_LABELS[camera.status]}</StatusBadge>
                </div>
                <dl className="grid gap-1 text-xs text-stone-600">
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-400">Mode</dt>
                    <dd>{camera.currentMode ? `${camera.currentMode.width}x${camera.currentMode.height} ${camera.currentMode.inputFormat}` : "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-400">Capture source</dt>
                    <dd>{camera.captureSourceId ? "assigned" : "unassigned"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-400">Last capture</dt>
                    <dd>{camera.lastCaptureAt ? formatAge(camera.lastCaptureAt) : "never"}</dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
