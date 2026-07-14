/**
 * Client-side helper for the metric history API
 * (GET /api/nodes/:nodeName/metrics/history - see
 * src/lib/operations/metricHistory.ts for the server-side query engine).
 * Deliberately generic: it knows about "sensors" and "metrics" as opaque
 * subjects, never about DHT22s, greenhouses, or any other domain concept -
 * that belongs in the caller (e.g. GreenhousePanel/SensorDetailPanel).
 */

/** Mirrors src/lib/operations/metricHistory.ts's HistoryResolution without importing that server-only module. */
export type HistoryResolution = "raw" | "5m" | "15m" | "1h";

export type NormalizedPoint = { at: number; value: number | null };

export type NormalizedSeries = {
  key: string;
  subjectKey: string;
  metric: string;
  label: string;
  unit: string;
  points: NormalizedPoint[];
};

export type HistoryRangeValue = "1h" | "6h" | "24h" | "7d" | "30d";

export type HistoryRangeDefinition = {
  value: HistoryRangeValue;
  label: string;
  durationMs: number;
  resolution: HistoryResolution;
};

/**
 * Recommended range -> resolution mapping (see task spec): short ranges use
 * raw points since the point count stays small; longer ranges bucket to
 * keep the response and the rendered chart both reasonably sized.
 */
export const HISTORY_RANGES: readonly HistoryRangeDefinition[] = [
  { value: "1h", label: "1h", durationMs: 60 * 60_000, resolution: "raw" },
  { value: "6h", label: "6h", durationMs: 6 * 60 * 60_000, resolution: "raw" },
  { value: "24h", label: "24h", durationMs: 24 * 60 * 60_000, resolution: "15m" },
  { value: "7d", label: "7d", durationMs: 7 * 24 * 60 * 60_000, resolution: "1h" },
  { value: "30d", label: "30d", durationMs: 30 * 24 * 60 * 60_000, resolution: "1h" },
] as const;

export const DEFAULT_HISTORY_RANGE: HistoryRangeValue = "24h";

const RESOLUTION_MS: Record<Exclude<HistoryResolution, "raw">, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

export function rangeDefinition(value: HistoryRangeValue): HistoryRangeDefinition {
  const found = HISTORY_RANGES.find((range) => range.value === value);
  if (!found) throw new Error(`Unknown history range "${value}".`);
  return found;
}

/**
 * A gap larger than this threshold is rendered as a visible break in the
 * line rather than smoothly interpolated across missing data - see
 * insertGapBreaks(). For bucketed resolutions a missing bucket simply has
 * no row at all, so the threshold is a small multiple of the bucket size.
 * For raw points there's no fixed sampling interval to reference, so the
 * threshold is derived from the data's own median spacing.
 */
export function defaultGapThresholdMs(resolution: HistoryResolution, points: ReadonlyArray<{ at: number }>): number {
  if (resolution !== "raw") return RESOLUTION_MS[resolution] * 2.5;

  const FALLBACK_MS = 30 * 60_000;
  if (points.length < 2) return FALLBACK_MS;

  const deltas: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    deltas.push(points[i].at - points[i - 1].at);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.max(FALLBACK_MS, median * 6);
}

/**
 * Inserts a null-valued point between any two consecutive points whose gap
 * exceeds thresholdMs, so a missing-data interval renders as a visible
 * break in the line rather than a deceptive straight interpolation across
 * it. Recharts (like most charting libraries) does not draw a line segment
 * through a null value by default.
 */
export function insertGapBreaks(points: readonly NormalizedPoint[], thresholdMs: number): NormalizedPoint[] {
  if (points.length < 2) return [...points];
  const out: NormalizedPoint[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    if (current.at - prev.at > thresholdMs) {
      out.push({ at: prev.at + 1, value: null });
    }
    out.push(current);
  }
  return out;
}

export type MetricHistoryFetchParams = {
  nodeName: string;
  sensorKeys: string[];
  metrics: string[];
  range: HistoryRangeValue;
  now?: Date;
  timeZone?: string;
  fetchImpl?: typeof fetch;
};

export type MetricHistoryFetchResult =
  | { ok: true; resolution: HistoryResolution; rangeFrom: number; rangeTo: number; seriesByMetric: Record<string, NormalizedSeries[]> }
  | { ok: false; error: string };

/**
 * Fetches and normalizes GET /api/nodes/:nodeName/metrics/history for one
 * or more metrics/sensors at once (one request covers every metric x sensor
 * combination the caller needs), grouping the response by metric and
 * inserting gap breaks per series.
 */
export async function fetchMetricHistory(params: MetricHistoryFetchParams): Promise<MetricHistoryFetchResult> {
  if (params.sensorKeys.length === 0 || params.metrics.length === 0) {
    return { ok: true, resolution: "raw", rangeFrom: 0, rangeTo: 0, seriesByMetric: Object.fromEntries(params.metrics.map((metric) => [metric, []])) };
  }

  const definition = rangeDefinition(params.range);
  const now = params.now ?? new Date();
  const from = new Date(now.getTime() - definition.durationMs);

  const search = new URLSearchParams({
    sensorKeys: params.sensorKeys.join(","),
    metrics: params.metrics.join(","),
    resolution: definition.resolution,
    from: from.toISOString(),
    to: now.toISOString(),
  });
  if (params.timeZone) search.set("timeZone", params.timeZone);

  const doFetch = params.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`/api/nodes/${params.nodeName}/metrics/history?${search.toString()}`, { cache: "no-store" });
  } catch {
    return { ok: false, error: "Could not reach the coordinator." };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: typeof body.error === "string" ? body.error : "Could not load history." };
  }

  const resolution: HistoryResolution = body.range?.resolution ?? definition.resolution;
  const rangeFrom = body.range?.from ? new Date(body.range.from).getTime() : from.getTime();
  const rangeTo = body.range?.to ? new Date(body.range.to).getTime() : now.getTime();

  const seriesByMetric: Record<string, NormalizedSeries[]> = Object.fromEntries(params.metrics.map((metric) => [metric, []]));
  const rawSeries: Array<{ key: string; subjectKey: string; metric: string; label: string; unit: string; points: Array<{ at: string; value: number }> }> =
    Array.isArray(body.series) ? body.series : [];

  for (const series of rawSeries) {
    const points = series.points
      .map((point): NormalizedPoint => ({ at: new Date(point.at).getTime(), value: point.value }))
      .sort((a, b) => a.at - b.at);
    const threshold = defaultGapThresholdMs(resolution, points);
    const normalized: NormalizedSeries = {
      key: series.key,
      subjectKey: series.subjectKey,
      metric: series.metric,
      label: series.label,
      unit: series.unit,
      points: insertGapBreaks(points, threshold),
    };
    if (!seriesByMetric[series.metric]) seriesByMetric[series.metric] = [];
    seriesByMetric[series.metric].push(normalized);
  }

  return { ok: true, resolution, rangeFrom, rangeTo, seriesByMetric };
}
