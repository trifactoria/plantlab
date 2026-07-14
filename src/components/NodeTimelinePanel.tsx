"use client";

import { useEffect, useState } from "react";
import { formatAge } from "@/lib/greenhouseDisplay";

type TimelineEntry = {
  id: string;
  at: string;
  category: "sensors" | "power" | "cameras" | "agent";
  summary: string;
  detail: string | null;
  tone: "info" | "success" | "warning" | "error";
};

const TONE_STYLES: Record<TimelineEntry["tone"], string> = {
  info: "border-stone-200 bg-stone-50 text-stone-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-red-200 bg-red-50 text-red-900",
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "sensors", label: "Sensors" },
  { value: "power", label: "Power" },
  { value: "cameras", label: "Cameras" },
  { value: "agent", label: "Agent/service" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

/**
 * Recent-activity timeline for one node: sensor diagnostics/tests, power
 * command/schedule outcomes, camera inventory, and heartbeats - all read
 * from GET /api/nodes/:nodeName/timeline (see getNodeTimeline() in
 * src/lib/operations/nodeDetail.ts, which composes this entirely from
 * already-persisted rows). Shared between the compact "Recent activity"
 * card on the node overview and the dedicated /nodes/[nodeName]/activity
 * page.
 */
export function NodeTimelinePanel({ nodeName, initialFilter = "all" }: { nodeName: string; initialFilter?: FilterValue }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [filter, setFilter] = useState<FilterValue>(initialFilter);

  useEffect(() => {
    let cancelled = false;
    async function loadTimeline() {
      const response = await fetch(`/api/nodes/${nodeName}/timeline?filter=${filter}`, { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const body = await response.json();
      if (!cancelled) setEntries(body.entries);
    }
    void loadTimeline();
    return () => {
      cancelled = true;
    };
  }, [nodeName, filter]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${filter === option.value ? "border-emerald-300 bg-emerald-100 text-emerald-900" : "border-stone-200 bg-white text-stone-600 hover:border-emerald-300"}`}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {entries === null ? (
          <p className="text-sm text-stone-600">Loading recent activity...</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-stone-600">No recent activity.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`rounded-md border px-3 py-2 text-sm ${TONE_STYLES[entry.tone]}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{entry.summary}</span>
                <span className="text-xs">{formatAge(entry.at)}</span>
              </div>
              {entry.detail ? <p className="mt-1 text-xs">{entry.detail}</p> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
