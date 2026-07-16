"use client";

import { useState } from "react";
import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";

type RefreshState = "idle" | "requested" | "waiting" | "succeeded" | "failed";

/**
 * Requests a camera inventory refresh through the owning node (never local
 * V4L2 discovery of a remote camera), then polls the canonical fleet camera
 * summary until the node re-reports inventory (its lastInventoryAt advances),
 * and hands the reloaded summary back so supported modes repopulate without a
 * page reload. Works for any node - local or remote - via node.name.
 */
export function CameraInventoryRefreshAction({
  camera,
  onRefreshed,
  label = "Refresh camera inventory",
}: {
  camera: FleetCameraSummary;
  onRefreshed: (camera: FleetCameraSummary) => void;
  label?: string;
}) {
  const [state, setState] = useState<RefreshState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setState("requested");
    setError(null);
    const before = camera.node.lastInventoryAt ? new Date(camera.node.lastInventoryAt).getTime() : 0;

    let requestRes: Response;
    try {
      requestRes = await fetch(`/api/nodes/${encodeURIComponent(camera.node.name)}/cameras/refresh-request`, { method: "POST" });
    } catch {
      setState("failed");
      setError("Could not reach the coordinator.");
      return;
    }
    if (!requestRes.ok) {
      const body = await requestRes.json().catch(() => ({}));
      setState("failed");
      setError(typeof body.error === "string" ? body.error : "Could not request inventory refresh.");
      return;
    }

    setState("waiting");
    // Poll the fleet summary until the owning node re-reports inventory.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      let latest: FleetCameraSummary | null = null;
      try {
        const res = await fetch(`/api/hardware/cameras/${encodeURIComponent(camera.id)}`, { cache: "no-store" });
        if (res.ok) latest = (await res.json()).camera as FleetCameraSummary;
      } catch {
        // transient; keep polling
      }
      if (latest) {
        const after = latest.node.lastInventoryAt ? new Date(latest.node.lastInventoryAt).getTime() : 0;
        if (after > before) {
          setState("succeeded");
          onRefreshed(latest);
          return;
        }
      }
    }
    // Timed out waiting; reload once so the user sees the current state anyway.
    try {
      const res = await fetch(`/api/hardware/cameras/${encodeURIComponent(camera.id)}`, { cache: "no-store" });
      if (res.ok) onRefreshed((await res.json()).camera as FleetCameraSummary);
    } catch {
      // ignore
    }
    setState("failed");
    setError(`No inventory update received from ${camera.node.name} yet. It may be offline or slow to poll; try again shortly.`);
  }

  return (
    <div className="grid gap-1">
      <button type="button" className="button-secondary w-fit" onClick={refresh} disabled={state === "requested" || state === "waiting"}>
        {state === "requested" || state === "waiting" ? `Refreshing from ${camera.node.name}...` : label}
      </button>
      {state === "waiting" ? <p className="text-xs text-stone-500">Requested; waiting for {camera.node.name} to re-report its cameras.</p> : null}
      {state === "succeeded" ? <p className="text-xs font-medium text-emerald-700">Inventory updated from {camera.node.name}.</p> : null}
      {error ? <p className="text-xs font-medium text-amber-700">{error}</p> : null}
    </div>
  );
}
