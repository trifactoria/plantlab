"use client";

import { useState } from "react";
import type { NormalizedSeries } from "@/lib/metricHistory";
import type { NormalizedPowerTrack } from "@/lib/powerHistoryClient";
import { DEFAULT_SERIES_COLORS, MetricChart } from "./MetricChart";
import { PowerStateTrack } from "./PowerStateTrack";

/**
 * Reusable metric-with-overlays card: a temperature/humidity (or any metric)
 * line chart plus optional state lanes (power outlets today; irrigation,
 * pumps, CO2 later) sharing one timeline. The chart and the lanes are locked
 * to the same `[rangeFrom, rangeTo]` domain and aligned plot gutters so a
 * spike in the chart lines up with the outlet that was on at that moment.
 * Deliberately generic - it renders whatever series and tracks it is given.
 */
export function MetricTimelineCard({
  title,
  unit,
  series,
  rangeFrom,
  rangeTo,
  powerTracks = [],
  loading = false,
  error = null,
  emptyMessage = "No data for this range yet.",
  colors = DEFAULT_SERIES_COLORS,
  formatValue,
  height,
}: {
  title: string;
  unit: string;
  series: NormalizedSeries[];
  rangeFrom: number;
  rangeTo: number;
  powerTracks?: NormalizedPowerTrack[];
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  colors?: readonly string[];
  formatValue?: (value: number) => string;
  height?: number;
}) {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());

  function toggleSeries(key: string) {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasData = series.some((item) => item.points.some((point) => point.value !== null));
  const hasRange = rangeTo > rangeFrom;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold text-stone-950">{title}</h3>

      <div className="mt-3">
        {loading ? (
          <p className="py-8 text-center text-sm text-stone-600">Loading chart data...</p>
        ) : error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700" role="alert">
            {error}
          </p>
        ) : !hasData ? (
          <p className="py-8 text-center text-sm text-stone-600">{emptyMessage}</p>
        ) : (
          <>
            <MetricChart
              series={series}
              unit={unit}
              hiddenKeys={hiddenKeys}
              colors={colors}
              formatValue={formatValue}
              height={height}
              xDomain={hasRange ? [rangeFrom, rangeTo] : undefined}
            />
            {powerTracks.length > 0 && hasRange ? (
              <div className="mt-2 border-t border-stone-100 pt-2" data-testid="power-overlay">
                <p className="mb-1 pl-1 text-xs font-semibold uppercase tracking-wide text-stone-400">Power</p>
                {powerTracks.map((track) => (
                  <PowerStateTrack key={track.outletId} track={track} rangeFrom={rangeFrom} rangeTo={rangeTo} />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {!loading && !error && series.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`${title} series`}>
          {series.map((item, index) => {
            const color = colors[index % colors.length];
            const hidden = hiddenKeys.has(item.key);
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={!hidden}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${
                  hidden ? "border-stone-200 bg-stone-50 text-stone-400" : "border-stone-200 bg-white text-stone-700"
                }`}
                onClick={() => toggleSeries(item.key)}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: hidden ? "#d6d3d1" : color }} />
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
