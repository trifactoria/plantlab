"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { calculateMetricDomain, domainDefaultsForUnit, type MetricDomainOptions } from "@/lib/chartDomain";
import type { NormalizedSeries } from "@/lib/metricHistory";

/** Deliberately generic - a color per series index, cycling if there are more series than colors. Not tied to any particular sensor set. */
export const DEFAULT_SERIES_COLORS = ["#059669", "#2563eb", "#d97706", "#db2777", "#7c3aed", "#0891b2"];

function defaultFormatTimestamp(at: number): string {
  const date = new Date(at);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function defaultFormatValue(value: number): string {
  return value.toFixed(1);
}

type TooltipEntry = { color: string; name: string; value: number | null; payload: { at: number } };

function ChartTooltip({
  active,
  payload,
  unit,
  formatValue,
  formatTimestamp,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  unit: string;
  formatValue: (value: number) => string;
  formatTimestamp: (at: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const at = payload[0]?.payload?.at;
  const visible = payload.filter((entry) => entry.value !== null && entry.value !== undefined);
  if (visible.length === 0) return null;

  return (
    <div className="rounded-md border border-stone-200 bg-white p-2 text-xs shadow-md">
      {at !== undefined ? <p className="font-semibold text-stone-950">{formatTimestamp(at)}</p> : null}
      <div className="mt-1 grid gap-0.5">
        {visible.map((entry) => (
          <p key={entry.name} className="flex items-center gap-1.5 text-stone-700">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span>{entry.name}:</span>
            <span className="font-medium text-stone-950">
              {formatValue(entry.value as number)}
              {unit}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

export function MetricChart({
  series,
  unit,
  hiddenKeys,
  colors = DEFAULT_SERIES_COLORS,
  height = 260,
  formatValue = defaultFormatValue,
  formatTimestamp = defaultFormatTimestamp,
  domainOptions,
}: {
  series: NormalizedSeries[];
  unit: string;
  hiddenKeys?: ReadonlySet<string>;
  colors?: readonly string[];
  height?: number;
  formatValue?: (value: number) => string;
  formatTimestamp?: (at: number) => string;
  domainOptions?: MetricDomainOptions | null;
}) {
  const allPoints = series.flatMap((item) => item.points);
  const domain: [number, number] | undefined =
    allPoints.length > 0 ? [Math.min(...allPoints.map((point) => point.at)), Math.max(...allPoints.map((point) => point.at))] : undefined;
  const yDomainOptions = domainOptions === undefined ? domainDefaultsForUnit(unit) : domainOptions;
  const visibleValues = series
    .filter((item) => !hiddenKeys?.has(item.key))
    .flatMap((item) => item.points.map((point) => point.value));
  const yDomain = yDomainOptions ? calculateMetricDomain(visibleValues, yDomainOptions) : null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
        <XAxis
          dataKey="at"
          type="number"
          domain={domain ?? ["auto", "auto"]}
          tickFormatter={formatTimestamp}
          tick={{ fontSize: 11, fill: "#57534e" }}
          allowDuplicatedCategory={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#57534e" }}
          tickFormatter={(value: number) => formatValue(value)}
          width={44}
          domain={yDomain?.domain}
          ticks={yDomain?.ticks}
        />
        <Tooltip content={<ChartTooltip unit={unit} formatValue={formatValue} formatTimestamp={formatTimestamp} />} />
        {series.map((item, index) => {
          if (hiddenKeys?.has(item.key)) return null;
          const color = colors[index % colors.length];
          return (
            <Line
              key={item.key}
              name={item.label}
              data={item.points}
              dataKey="value"
              type="monotone"
              stroke={color}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              strokeWidth={2}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}
