"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { NodeSummary, NodeSummaryResponse } from "@/lib/operations/nodeSummary";
import { formatDateTime } from "@/lib/format";
import { formatAge } from "@/lib/greenhouseDisplay";
import { ResourceCountLink } from "@/components/shell/ResourceCountLink";
import { nodeStatusTone, StatusBadge } from "@/components/shell/StatusBadge";

const MODE_LABELS: Record<NodeSummary["mode"], string> = {
  coordinator: "Coordinator",
  standalone: "Standalone",
  "camera-node": "Camera node",
  "greenhouse-node": "Greenhouse node",
  mixed: "Mixed",
};

const STATUS_LABELS: Record<NodeSummary["status"], string> = {
  active: "Active",
  degraded: "Attention",
  pending: "Pending",
  offline: "Offline",
};

const POLL_INTERVAL_MS = 60_000;

/**
 * The primary system summary. One row per node-like installation, the current
 * installation ("self") always first, followed by any attached nodes. The same
 * table renders in standalone mode (just the self row) and coordinator mode
 * (self plus attached nodes) so the two modes look identical - the coordinator
 * simply has more rows. Camera and sensor counts link to their configuration
 * pages. Failed-job diagnostics deliberately do not appear here; they live in
 * each node's activity view.
 */
export function UnifiedNodeTable({ initial }: { initial?: NodeSummaryResponse }) {
  const [data, setData] = useState<NodeSummaryResponse | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/nodes/summary", { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        const body = (await res.json()) as NodeSummaryResponse;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not refresh node status.");
      }
    }
    void load();
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const nodes = data?.nodes ?? [];

  return (
    <div className="rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
        <h2 className="text-lg font-semibold text-stone-950">Nodes</h2>
        {error ? <span className="text-xs text-amber-700">{error}</span> : null}
      </div>
      <div className="overflow-x-auto border-t border-stone-200">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="bg-stone-50 text-xs font-semibold uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-5 py-2">Node</th>
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Activity</th>
              <th className="px-3 py-2">Cameras</th>
              <th className="px-3 py-2">Sensors</th>
            </tr>
          </thead>
          <tbody>
            {nodes.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-4 text-stone-600">
                  {data ? "No nodes registered yet." : "Loading node status..."}
                </td>
              </tr>
            ) : (
              nodes.map((node) => (
                <tr key={node.id} className="border-t border-stone-100 align-top" data-testid={`node-row-${node.name}`}>
                  <td className="px-5 py-3">
                    <Link href={node.detailsUrl} className="font-semibold text-stone-950 hover:underline">
                      {node.displayName}
                    </Link>
                    {node.relationship === "self" ? (
                      <span className="ml-2 rounded border border-emerald-200 bg-emerald-50 px-1 text-xs font-semibold text-emerald-800">
                        This install
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-stone-600">{MODE_LABELS[node.mode]}</td>
                  <td className="px-3 py-3">
                    <StatusBadge tone={nodeStatusTone(node.status)}>{STATUS_LABELS[node.status]}</StatusBadge>
                  </td>
                  <td className="px-3 py-3 text-stone-600">
                    <Link href={node.activityUrl} className="hover:underline">
                      {node.activity.label}
                    </Link>
                    <div className="text-xs text-stone-400">
                      {node.activity.at
                        ? `${formatAge(node.activity.at)} (${formatDateTime(node.activity.at)})`
                        : node.activity.kind === "pending"
                          ? "no activity yet"
                          : "live"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <ResourceCountLink href={node.resources.cameras.url} count={node.resources.cameras.count} attention={node.resources.cameras.unavailable} noun="cameras" />
                  </td>
                  <td className="px-3 py-3">
                    <ResourceCountLink href={node.resources.sensors.url} count={node.resources.sensors.count} attention={node.resources.sensors.degraded} noun="sensors" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
