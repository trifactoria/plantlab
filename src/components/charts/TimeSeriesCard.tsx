"use client";

import { useState } from "react";
import { HISTORY_RANGES, type HistoryRangeValue, type NormalizedSeries } from "@/lib/metricHistory";
import { DEFAULT_SERIES_COLORS, MetricChart } from "./MetricChart";
import { RangeSelector } from "./RangeSelector";

export type TimeSeriesSummaryValue = { label: string; value: string };

/**
 * Reusable time-series display card: title, optional range selector,
 * loading/error/empty states, a clickable legend for toggling series on and
 * off, and optional summary values (e.g. current/min/max). Deliberately
 * generic - it renders whatever series it is given and has no notion of
 * sensors, DHT22s, or greenhouses. See MetricChart for the underlying
 * Recharts rendering and src/lib/metricHistory.ts for data normalization.
 */
export function TimeSeriesCard({
  title,
  unit,
  series,
  range,
  onRangeChange,
  rangeOptions = HISTORY_RANGES,
  showRangeSelector = true,
  loading = false,
  error = null,
  emptyMessage = "No data for this range yet.",
  summaryValues,
  colors = DEFAULT_SERIES_COLORS,
  formatValue,
  formatTimestamp,
  height,
}: {
  title: string;
  unit: string;
  series: NormalizedSeries[];
  range: HistoryRangeValue;
  onRangeChange?: (range: HistoryRangeValue) => void;
  rangeOptions?: readonly { value: HistoryRangeValue; label: string }[];
  showRangeSelector?: boolean;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  summaryValues?: TimeSeriesSummaryValue[];
  colors?: readonly string[];
  formatValue?: (value: number) => string;
  formatTimestamp?: (at: number) => string;
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

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-stone-950">{title}</h3>
        {showRangeSelector && onRangeChange ? <RangeSelector value={range} onChange={onRangeChange} options={rangeOptions} label={`${title} range`} /> : null}
      </div>

      {summaryValues && summaryValues.length > 0 ? (
        <dl className="mt-3 flex flex-wrap gap-4 text-sm">
          {summaryValues.map((item) => (
            <div key={item.label}>
              <dt className="text-xs font-medium text-stone-500">{item.label}</dt>
              <dd className="font-semibold text-stone-950">{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

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
          <MetricChart series={series} unit={unit} hiddenKeys={hiddenKeys} colors={colors} formatValue={formatValue} formatTimestamp={formatTimestamp} height={height} />
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
