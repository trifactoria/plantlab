"use client";

import { CHART_LEFT_GUTTER_PX, CHART_RIGHT_GUTTER_PX } from "./MetricChart";
import type { NormalizedPowerTrack } from "@/lib/powerHistoryClient";

function pct(value: number, from: number, to: number) {
  if (to <= from) return 0;
  return Math.min(100, Math.max(0, ((value - from) / (to - from)) * 100));
}

/**
 * One generic state lane (e.g. an outlet's observed ON/OFF history) aligned to
 * a shared time domain so it sits directly beneath a metric chart on the same
 * timeline. The label column and right inset match the chart's plot gutters
 * (CHART_LEFT_GUTTER_PX / CHART_RIGHT_GUTTER_PX) so ON bars line up with the
 * chart's time axis. Nothing here is outlet-specific: any boolean state track
 * (irrigation, pumps, CO2) can reuse it.
 */
export function PowerStateTrack({
  track,
  rangeFrom,
  rangeTo,
}: {
  track: NormalizedPowerTrack;
  rangeFrom: number;
  rangeTo: number;
}) {
  const onSegments = track.segments.filter((segment) => segment.state);
  const anyOn = onSegments.length > 0;

  return (
    <div className="flex items-center py-0.5 text-xs" data-testid={`power-track-${track.outletKey}`}>
      <div style={{ width: CHART_LEFT_GUTTER_PX }} className="shrink-0 truncate pr-2 text-right font-medium text-stone-600" title={track.label}>
        {track.label}
      </div>
      <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-stone-100" style={{ marginRight: CHART_RIGHT_GUTTER_PX }}>
        {/* Unknown (pre-range or reporting gap) intervals as a light hatch. */}
        {track.gaps.map((gap, index) => (
          <div
            key={`gap-${index}`}
            className="absolute inset-y-0 bg-[repeating-linear-gradient(45deg,#e7e5e4_0,#e7e5e4_3px,transparent_3px,transparent_6px)]"
            style={{ left: `${pct(gap.from, rangeFrom, rangeTo)}%`, width: `${pct(gap.to, rangeFrom, rangeTo) - pct(gap.from, rangeFrom, rangeTo)}%` }}
          />
        ))}
        {onSegments.map((segment, index) => (
          <div
            key={`on-${index}`}
            className="absolute inset-y-0 rounded-sm bg-emerald-500"
            style={{ left: `${pct(segment.from, rangeFrom, rangeTo)}%`, width: `${Math.max(0.4, pct(segment.to, rangeFrom, rangeTo) - pct(segment.from, rangeFrom, rangeTo))}%` }}
            title={`On ${new Date(segment.from).toLocaleString()} - ${new Date(segment.to).toLocaleString()}`}
          />
        ))}
        {!anyOn && track.gaps.length === 0 ? <div className="absolute inset-0 grid place-items-center text-[10px] text-stone-400">off</div> : null}
      </div>
    </div>
  );
}
