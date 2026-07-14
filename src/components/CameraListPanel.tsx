"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { formatAge } from "@/lib/greenhouseDisplay";

type NodeCameraRow = {
  stableId: string;
  name: string;
  devicePath: string;
  available: boolean;
  lastSeenAt: string;
  vendorId: string | null;
  productId: string | null;
  serial: string | null;
  captureSourceId: string | null;
  formatsCount: number;
};

const POLL_INTERVAL_MS = 30_000;

/**
 * Read-only list of a node's known cameras: availability and device/
 * inventory information already reported by the agent, linking to the
 * existing capture-source setup surface when a camera is attached to one.
 * See /nodes/[nodeName]/cameras.
 */
export function CameraListPanel({ nodeName }: { nodeName: string }) {
  const [cameras, setCameras] = useState<NodeCameraRow[] | null>(null);
  const [nodeMissing, setNodeMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/nodes/${nodeName}/cameras`, { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 404) {
          setNodeMissing(true);
          return;
        }
        if (!response.ok) {
          setLoadError("Could not load camera list from the coordinator.");
          return;
        }
        const body = await response.json();
        setLoadError(null);
        setCameras(body.cameras);
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
  if (cameras === null) {
    return <p className="text-sm text-stone-600">Loading cameras...</p>;
  }
  if (cameras.length === 0) {
    return <p className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-600">No cameras reported for this node yet.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cameras.map((camera) => (
        <div key={camera.stableId} className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-stone-950">{camera.name}</h3>
            <span
              className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${
                camera.available ? "border-emerald-200 bg-emerald-100 text-emerald-900" : "border-stone-200 bg-stone-100 text-stone-700"
              }`}
            >
              {camera.available ? "Available" : "Unavailable"}
            </span>
          </div>
          <dl className="mt-3 grid gap-1 text-xs text-stone-600">
            <div>
              <dt className="inline font-medium text-stone-700">Device: </dt>
              <dd className="inline">{camera.devicePath}</dd>
            </div>
            {camera.vendorId || camera.productId ? (
              <div>
                <dt className="inline font-medium text-stone-700">USB ID: </dt>
                <dd className="inline">
                  {camera.vendorId ?? "?"}:{camera.productId ?? "?"}
                </dd>
              </div>
            ) : null}
            {camera.serial ? (
              <div>
                <dt className="inline font-medium text-stone-700">Serial: </dt>
                <dd className="inline">{camera.serial}</dd>
              </div>
            ) : null}
            <div>
              <dt className="inline font-medium text-stone-700">Advertised modes: </dt>
              <dd className="inline">{camera.formatsCount > 0 ? camera.formatsCount : "none reported"}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-stone-700">Last seen: </dt>
              <dd className="inline">
                {formatAge(camera.lastSeenAt)} ({formatDateTime(camera.lastSeenAt)})
              </dd>
            </div>
          </dl>
          {camera.captureSourceId ? (
            <Link href={`/capture-sources/${camera.captureSourceId}`} className="mt-3 inline-block text-xs font-semibold text-emerald-700 hover:underline">
              View capture source &rarr;
            </Link>
          ) : (
            <p className="mt-3 text-xs text-stone-500">Not yet attached to a capture source.</p>
          )}
        </div>
      ))}
    </div>
  );
}
