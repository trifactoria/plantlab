import { Prisma, type PrismaClient } from "@prisma/client";
import { DEFAULT_TIME_ZONE } from "../timezone";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/metricHistory.ts is server-only operational code.");
}

export const HISTORY_METRICS = ["temperatureC", "humidityPct"] as const;
export type HistoryMetric = (typeof HISTORY_METRICS)[number];
export const HISTORY_RESOLUTIONS = ["raw", "5m", "15m", "1h"] as const;
export type HistoryResolution = (typeof HISTORY_RESOLUTIONS)[number];

const METRIC_DEFINITIONS: Record<HistoryMetric, { column: "temperatureC" | "humidityPct"; unit: string; label: string }> = {
  temperatureC: { column: "temperatureC", unit: "celsius", label: "temperature" },
  humidityPct: { column: "humidityPct", unit: "percent", label: "humidity" },
};

const RESOLUTION_SECONDS: Record<Exclude<HistoryResolution, "raw">, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
};

const MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
const MAX_RAW_POINTS = 20_000;
const MAX_BUCKET_POINTS = 20_000;
const MAX_SENSOR_KEYS = 20;

export type MetricHistoryPoint =
  | { at: string; value: number }
  | { at: string; value: number; count: number; min: number; max: number; mean: number; first: number; last: number };

export type MetricHistorySeries = {
  key: string;
  subjectKey: string;
  metric: HistoryMetric;
  label: string;
  unit: string;
  points: MetricHistoryPoint[];
};

export type MetricHistoryResult =
  | { ok: true; status: 200; body: { node: { name: string }; range: { from: string; to: string; resolution: HistoryResolution; timeZone: string; bucketSemantics: "utc" }; series: MetricHistorySeries[] } }
  | { ok: false; status: 400 | 404 | 413; error: string };

export type ProjectMetricHistorySeries = MetricHistorySeries & {
  bindingId: string;
  node: { id: string; name: string };
  sensorId: string;
  role: string;
  degraded: boolean;
};

export type ProjectMetricHistoryResult =
  | { ok: true; status: 200; body: { project: { id: string; name: string }; range: { from: string; to: string; resolution: HistoryResolution; timeZone: string; bucketSemantics: "utc" }; series: ProjectMetricHistorySeries[] } }
  | { ok: false; status: 400 | 404 | 413; error: string };

export async function getMetricHistory(prisma: PrismaClient, nodeName: string, params: URLSearchParams, now = new Date()): Promise<MetricHistoryResult> {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: { sensors: { orderBy: [{ placement: "asc" }, { key: "asc" }] } },
  });
  if (!node) return { ok: false, status: 404, error: `No registered node named "${nodeName}".` };

  const parsed = parseHistoryParams(params, now);
  if (!parsed.ok) return parsed;
  const { sensorKeys, metrics, from, to, resolution, timeZone } = parsed.value;

  const sensorsByKey = new Map(node.sensors.map((sensor) => [sensor.key, sensor]));
  const missingSensors = sensorKeys.filter((key) => !sensorsByKey.has(key));
  if (missingSensors.length > 0) return { ok: false, status: 400, error: `Unknown sensor key(s): ${missingSensors.join(", ")}.` };

  const sensors = sensorKeys.map((key) => sensorsByKey.get(key)!);
  const series = buildEmptySeries(sensors, metrics);

  if (resolution === "raw") {
    const readings = await prisma.sensorReading.findMany({
      where: {
        nodeId: node.id,
        sensorId: { in: sensors.map((sensor) => sensor.id) },
        capturedAt: { gte: from, lte: to },
      },
      orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
      take: Math.floor(MAX_RAW_POINTS / metrics.length) + 1,
    });
    if (readings.length * metrics.length > MAX_RAW_POINTS) {
      return { ok: false, status: 413, error: `Raw history response is too large. Narrow the range or request a bucketed resolution.` };
    }
    const seriesByKey = new Map(series.map((item) => [item.key, item]));
    for (const reading of readings) {
      const sensor = sensors.find((candidate) => candidate.id === reading.sensorId);
      if (!sensor) continue;
      for (const metric of metrics) {
        const value = reading[METRIC_DEFINITIONS[metric].column];
        seriesByKey.get(`${sensor.key}:${metric}`)?.points.push({ at: reading.capturedAt.toISOString(), value });
      }
    }
  } else {
    const bucketSeconds = RESOLUTION_SECONDS[resolution];
    const bucketCount = Math.ceil((to.getTime() - from.getTime()) / (bucketSeconds * 1000));
    if (bucketCount * sensors.length * metrics.length > MAX_BUCKET_POINTS) {
      return { ok: false, status: 413, error: `Bucketed history response is too large. Narrow the range, request fewer series, or use a coarser resolution.` };
    }
    const seriesByKey = new Map(series.map((item) => [item.key, item]));
    for (const metric of metrics) {
      const rows = await queryBuckets(prisma, node.id, sensors.map((sensor) => sensor.id), from, to, metric, bucketSeconds);
      for (const row of rows) {
        const sensor = sensors.find((candidate) => candidate.id === row.sensorId);
        if (!sensor) continue;
        const mean = Number(row.mean);
        seriesByKey.get(`${sensor.key}:${metric}`)?.points.push({
          at: new Date(Number(row.bucketEpoch) * 1000).toISOString(),
          value: mean,
          count: Number(row.count),
          min: Number(row.min),
          max: Number(row.max),
          mean,
          first: Number(row.first),
          last: Number(row.last),
        });
      }
    }
  }

  return {
    ok: true,
    status: 200,
    body: {
      node: { name: node.name },
      range: { from: from.toISOString(), to: to.toISOString(), resolution, timeZone, bucketSemantics: "utc" },
      series,
    },
  };
}

export async function getProjectMetricHistory(
  prisma: PrismaClient,
  projectId: string,
  params: URLSearchParams,
  now = new Date(),
): Promise<ProjectMetricHistoryResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      sensorBindings: {
        where: { enabled: true, unlinkedAt: null },
        include: { node: true, sensor: true },
        orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!project) return { ok: false, status: 404, error: "Project not found." };

  const parsed = parseProjectHistoryParams(params, now);
  if (!parsed.ok) return parsed;
  const { bindingIds, metrics, from, to, resolution, timeZone } = parsed.value;

  const bindings = bindingIds.length > 0 ? project.sensorBindings.filter((binding) => bindingIds.includes(binding.id)) : project.sensorBindings;
  const missingBindings = bindingIds.filter((id) => !project.sensorBindings.some((binding) => binding.id === id));
  if (missingBindings.length > 0) return { ok: false, status: 400, error: `Unknown sensor binding id(s): ${missingBindings.join(", ")}.` };

  const series = buildEmptyProjectSeries(bindings, metrics);
  const sensorIds = bindings.map((binding) => binding.sensorId);

  if (resolution === "raw") {
    const readings = await prisma.sensorReading.findMany({
      where: { sensorId: { in: sensorIds }, capturedAt: { gte: from, lte: to } },
      orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
      take: Math.floor(MAX_RAW_POINTS / metrics.length) + 1,
    });
    if (readings.length * metrics.length > MAX_RAW_POINTS) {
      return { ok: false, status: 413, error: "Raw history response is too large. Narrow the range or request a bucketed resolution." };
    }
    const seriesByKey = new Map(series.map((item) => [item.key, item]));
    for (const reading of readings) {
      for (const binding of bindings.filter((candidate) => candidate.sensorId === reading.sensorId)) {
        for (const metric of metrics) {
          const value = reading[METRIC_DEFINITIONS[metric].column];
          seriesByKey.get(`${binding.id}:${metric}`)?.points.push({ at: reading.capturedAt.toISOString(), value });
        }
      }
    }
  } else {
    const bucketSeconds = RESOLUTION_SECONDS[resolution];
    const bucketCount = Math.ceil((to.getTime() - from.getTime()) / (bucketSeconds * 1000));
    if (bucketCount * bindings.length * metrics.length > MAX_BUCKET_POINTS) {
      return { ok: false, status: 413, error: "Bucketed history response is too large. Narrow the range, request fewer series, or use a coarser resolution." };
    }
    const seriesByKey = new Map(series.map((item) => [item.key, item]));
    for (const metric of metrics) {
      const rows = await queryBuckets(prisma, null, sensorIds, from, to, metric, bucketSeconds);
      for (const row of rows) {
        for (const binding of bindings.filter((candidate) => candidate.sensorId === row.sensorId)) {
          const mean = Number(row.mean);
          seriesByKey.get(`${binding.id}:${metric}`)?.points.push({
            at: new Date(Number(row.bucketEpoch) * 1000).toISOString(),
            value: mean,
            count: Number(row.count),
            min: Number(row.min),
            max: Number(row.max),
            mean,
            first: Number(row.first),
            last: Number(row.last),
          });
        }
      }
    }
  }

  return {
    ok: true,
    status: 200,
    body: {
      project: { id: project.id, name: project.name },
      range: { from: from.toISOString(), to: to.toISOString(), resolution, timeZone, bucketSemantics: "utc" },
      series,
    },
  };
}

type ParsedParams = {
  sensorKeys: string[];
  metrics: HistoryMetric[];
  from: Date;
  to: Date;
  resolution: HistoryResolution;
  timeZone: string;
};

function parseHistoryParams(params: URLSearchParams, now: Date): { ok: true; value: ParsedParams } | { ok: false; status: 400; error: string } {
  const sensorKeys = splitList(params.get("sensorKeys"));
  if (sensorKeys.length === 0) return { ok: false, status: 400, error: "sensorKeys is required." };
  if (sensorKeys.length > MAX_SENSOR_KEYS) return { ok: false, status: 400, error: `sensorKeys may contain at most ${MAX_SENSOR_KEYS} entries.` };
  if (sensorKeys.some((key) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key))) return { ok: false, status: 400, error: "sensorKeys contains an invalid key." };

  const parsed = parseHistoryParamsBase(params, now);
  if (!parsed.ok) return parsed;

  return { ok: true, value: { sensorKeys, ...parsed.value } };
}

type ParsedProjectParams = Omit<ParsedParams, "sensorKeys"> & { bindingIds: string[] };

function parseProjectHistoryParams(params: URLSearchParams, now: Date): { ok: true; value: ParsedProjectParams } | { ok: false; status: 400; error: string } {
  const bindingIds = splitList(params.get("bindingIds"));
  if (bindingIds.length > MAX_SENSOR_KEYS) return { ok: false, status: 400, error: `bindingIds may contain at most ${MAX_SENSOR_KEYS} entries.` };
  if (bindingIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))) return { ok: false, status: 400, error: "bindingIds contains an invalid id." };

  const parsed = parseHistoryParamsBase(params, now);
  if (!parsed.ok) return parsed;

  return { ok: true, value: { bindingIds, ...parsed.value } };
}

function parseHistoryParamsBase(params: URLSearchParams, now: Date): { ok: true; value: Omit<ParsedParams, "sensorKeys"> } | { ok: false; status: 400; error: string } {
  const metricValues = splitList(params.get("metrics"));
  if (metricValues.length === 0) return { ok: false, status: 400, error: "metrics is required." };
  const metrics: HistoryMetric[] = [];
  for (const metric of metricValues) {
    if (!(HISTORY_METRICS as readonly string[]).includes(metric)) return { ok: false, status: 400, error: `Invalid metric "${metric}".` };
    if (!metrics.includes(metric as HistoryMetric)) metrics.push(metric as HistoryMetric);
  }

  const resolutionValue = params.get("resolution") ?? "raw";
  if (!(HISTORY_RESOLUTIONS as readonly string[]).includes(resolutionValue)) return { ok: false, status: 400, error: `Invalid resolution "${resolutionValue}".` };
  const resolution = resolutionValue as HistoryResolution;

  const to = params.has("to") ? parseTimestamp(params.get("to"), "to") : now;
  if (!to) return { ok: false, status: 400, error: "to must be a valid ISO timestamp." };
  const from = params.has("from") ? parseTimestamp(params.get("from"), "from") : new Date(to.getTime() - 24 * 60 * 60_000);
  if (!from) return { ok: false, status: 400, error: "from must be a valid ISO timestamp." };
  if (from.getTime() >= to.getTime()) return { ok: false, status: 400, error: "from must be before to." };
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) return { ok: false, status: 400, error: "History range must be 31 days or less." };

  const timeZone = params.get("timeZone") || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) return { ok: false, status: 400, error: "timeZone must be a valid IANA timezone identifier." };

  return { ok: true, value: { metrics, from, to, resolution, timeZone } };
}

function splitList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTimestamp(value: string | null, _label: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function buildEmptySeries(sensors: Array<{ key: string; name: string }>, metrics: HistoryMetric[]): MetricHistorySeries[] {
  return sensors.flatMap((sensor) =>
    metrics.map((metric) => {
      const definition = METRIC_DEFINITIONS[metric];
      return {
        key: `${sensor.key}:${metric}`,
        subjectKey: sensor.key,
        metric,
        label: `${sensor.name} ${definition.label}`,
        unit: definition.unit,
        points: [],
      };
    }),
  );
}

function buildEmptyProjectSeries(
  bindings: Array<{
    id: string;
    role: string;
    label: string | null;
    node: { id: string; name: string };
    sensor: { id: string; key: string; name: string; configuredActive: boolean; enabled: boolean; retiredAt: Date | null };
  }>,
  metrics: HistoryMetric[],
): ProjectMetricHistorySeries[] {
  return bindings.flatMap((binding) =>
    metrics.map((metric) => {
      const definition = METRIC_DEFINITIONS[metric];
      const displayLabel = binding.label ?? binding.sensor.name;
      return {
        key: `${binding.id}:${metric}`,
        subjectKey: binding.sensor.key,
        bindingId: binding.id,
        node: { id: binding.node.id, name: binding.node.name },
        sensorId: binding.sensor.id,
        role: binding.role,
        degraded: !binding.sensor.enabled || !binding.sensor.configuredActive || Boolean(binding.sensor.retiredAt),
        metric,
        label: `${displayLabel} ${definition.label}`,
        unit: definition.unit,
        points: [],
      };
    }),
  );
}

type BucketRow = {
  sensorId: string;
  bucketEpoch: bigint | number;
  count: bigint | number;
  min: number;
  max: number;
  mean: number;
  first: number;
  last: number;
};

function metricColumn(metric: HistoryMetric) {
  return Prisma.raw(METRIC_DEFINITIONS[metric].column);
}

async function queryBuckets(
  prisma: PrismaClient,
  nodeId: string | null,
  sensorIds: string[],
  from: Date,
  to: Date,
  metric: HistoryMetric,
  bucketSeconds: number,
): Promise<BucketRow[]> {
  if (sensorIds.length === 0) return [];
  const column = metricColumn(metric);
  return prisma.$queryRaw<BucketRow[]>(Prisma.sql`
    WITH base AS (
      SELECT
        "id",
        "sensorId",
        "capturedAt",
        ${column} AS value,
        (CAST(("capturedAt" / 1000) AS INTEGER) / ${bucketSeconds}) * ${bucketSeconds} AS bucketEpoch
      FROM "SensorReading"
      WHERE (${nodeId} IS NULL OR "nodeId" = ${nodeId})
        AND "sensorId" IN (${Prisma.join(sensorIds)})
        AND "capturedAt" >= ${from}
        AND "capturedAt" <= ${to}
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY "sensorId", bucketEpoch ORDER BY "capturedAt" ASC, "id" ASC) AS rnFirst,
        ROW_NUMBER() OVER (PARTITION BY "sensorId", bucketEpoch ORDER BY "capturedAt" DESC, "id" DESC) AS rnLast
      FROM base
    )
    SELECT
      "sensorId" AS sensorId,
      bucketEpoch,
      COUNT(*) AS count,
      MIN(value) AS min,
      MAX(value) AS max,
      AVG(value) AS mean,
      MAX(CASE WHEN rnFirst = 1 THEN value END) AS first,
      MAX(CASE WHEN rnLast = 1 THEN value END) AS last
    FROM ranked
    GROUP BY "sensorId", bucketEpoch
    ORDER BY bucketEpoch ASC, "sensorId" ASC
  `);
}
