export type MetricDomainOptions = {
  physicalMin?: number;
  physicalMax?: number;
  minimumSpan: number;
  paddingRatio: number;
  roundingStep: number;
};

export type MetricDomainResult = {
  domain: [number, number];
  ticks: number[];
  empty: boolean;
};

export const TEMPERATURE_F_DOMAIN: MetricDomainOptions = { minimumSpan: 6, paddingRatio: 0.12, roundingStep: 2 };
export const TEMPERATURE_C_DOMAIN: MetricDomainOptions = { minimumSpan: 3, paddingRatio: 0.12, roundingStep: 1 };
export const HUMIDITY_DOMAIN: MetricDomainOptions = { physicalMin: 0, physicalMax: 100, minimumSpan: 10, paddingRatio: 0.1, roundingStep: 5 };

export function calculateMetricDomain(values: Array<number | null | undefined>, options: MetricDomainOptions): MetricDomainResult {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) {
    const start = options.physicalMin ?? 0;
    const end = clamp(start + options.minimumSpan, options.physicalMin, options.physicalMax);
    return { domain: [start, end], ticks: buildTicks(start, end, options.roundingStep), empty: true };
  }

  let min = Math.min(...finite);
  let max = Math.max(...finite);
  const center = (min + max) / 2;
  const span = max - min;
  const padding = span > 0 ? span * options.paddingRatio : 0;
  min -= padding;
  max += padding;

  if (max - min < options.minimumSpan) {
    min = center - options.minimumSpan / 2;
    max = center + options.minimumSpan / 2;
  }

  [min, max] = applyPhysicalBounds(min, max, options);
  min = roundDown(min, options.roundingStep);
  max = roundUp(max, options.roundingStep);
  [min, max] = applyPhysicalBounds(min, max, options);
  if (max <= min) {
    max = min + options.roundingStep;
  }

  return { domain: [min, max], ticks: buildTicks(min, max, options.roundingStep), empty: false };
}

export function domainDefaultsForUnit(unit: string): MetricDomainOptions | null {
  if (unit === "%") return HUMIDITY_DOMAIN;
  if (unit === "°F" || unit.toLowerCase() === "fahrenheit") return TEMPERATURE_F_DOMAIN;
  if (unit === "°C" || unit.toLowerCase() === "celsius") return TEMPERATURE_C_DOMAIN;
  return null;
}

function applyPhysicalBounds(min: number, max: number, options: MetricDomainOptions): [number, number] {
  const physicalMin = options.physicalMin;
  const physicalMax = options.physicalMax;
  let nextMin = clamp(min, physicalMin, physicalMax);
  let nextMax = clamp(max, physicalMin, physicalMax);
  const span = nextMax - nextMin;
  if (span >= options.minimumSpan || physicalMin === undefined || physicalMax === undefined) {
    return [nextMin, nextMax];
  }

  if (nextMin <= physicalMin) {
    nextMax = Math.min(physicalMax, nextMin + options.minimumSpan);
  } else if (nextMax >= physicalMax) {
    nextMin = Math.max(physicalMin, nextMax - options.minimumSpan);
  } else {
    const missing = options.minimumSpan - span;
    nextMin = Math.max(physicalMin, nextMin - missing / 2);
    nextMax = Math.min(physicalMax, nextMax + missing / 2);
  }
  return [nextMin, nextMax];
}

function clamp(value: number, min?: number, max?: number) {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

function roundDown(value: number, step: number) {
  return Math.floor(value / step) * step;
}

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

function buildTicks(min: number, max: number, step: number) {
  const ticks: number[] = [];
  const limit = 24;
  let tickStep = step;
  while ((max - min) / tickStep > limit) {
    tickStep *= 2;
  }
  for (let value = min; value <= max + tickStep / 10; value += tickStep) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}
