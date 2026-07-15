export const SENSOR_HEALTH_STATES = ["healthy", "intermittent", "degraded", "failed", "node-offline"] as const;
export type SensorHealthState = (typeof SENSOR_HEALTH_STATES)[number];

export type SensorHealthThresholds = {
  degradedNoSuccessSeconds: number;
  failedNoSuccessSeconds: number;
  intermittentFailureCount: number;
  normalIntervalToleranceMultiplier: number;
  minimumFreshSeconds: number;
};

export const DEFAULT_SENSOR_HEALTH_THRESHOLDS: SensorHealthThresholds = {
  degradedNoSuccessSeconds: 3 * 60,
  failedNoSuccessSeconds: 5 * 60,
  intermittentFailureCount: 1,
  normalIntervalToleranceMultiplier: 2,
  minimumFreshSeconds: 90,
};

export type SensorHealthInput = {
  nodeOnline: boolean;
  enabled: boolean;
  configuredActive: boolean;
  retired: boolean;
  now: Date;
  samplingIntervalSeconds: number | null;
  lastAcceptedAt: Date | null;
  lastAttemptAt: Date | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  consecutiveFailures: number;
  consecutiveRejects: number;
  failureDurationSeconds: number | null;
};

export type SensorHealth = {
  state: SensorHealthState;
  reason: string | null;
  lastValidAt: string | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  consecutiveFailures: number;
  failureDurationSeconds: number | null;
};

export function evaluateSensorHealth(
  input: SensorHealthInput,
  thresholds: SensorHealthThresholds = DEFAULT_SENSOR_HEALTH_THRESHOLDS,
): SensorHealth {
  const lastValidAt = input.lastAcceptedAt?.toISOString() ?? null;
  const base = {
    lastValidAt,
    recentSuccessCount: input.recentSuccessCount,
    recentFailureCount: input.recentFailureCount,
    consecutiveFailures: input.consecutiveFailures,
    failureDurationSeconds: input.failureDurationSeconds,
  };

  if (!input.nodeOnline) {
    return { ...base, state: "node-offline", reason: "Node is offline." };
  }
  if (input.retired) {
    return { ...base, state: "degraded", reason: "Sensor is retired." };
  }
  if (!input.enabled) {
    return { ...base, state: "degraded", reason: "Sensor is disabled." };
  }
  if (!input.configuredActive) {
    return { ...base, state: "degraded", reason: "Sensor is not active in the applied configuration." };
  }

  const lastAcceptedAgeSeconds = input.lastAcceptedAt ? Math.max(0, (input.now.getTime() - input.lastAcceptedAt.getTime()) / 1000) : null;
  const noSuccessSeconds = lastAcceptedAgeSeconds ?? input.failureDurationSeconds ?? (input.lastAttemptAt ? Math.max(0, (input.now.getTime() - input.lastAttemptAt.getTime()) / 1000) : null);

  if (noSuccessSeconds !== null && noSuccessSeconds >= thresholds.failedNoSuccessSeconds) {
    return { ...base, state: "failed", reason: `No accepted reading for at least ${thresholds.failedNoSuccessSeconds / 60} minutes.` };
  }
  if (noSuccessSeconds !== null && noSuccessSeconds >= thresholds.degradedNoSuccessSeconds) {
    return { ...base, state: "degraded", reason: `No accepted reading for at least ${thresholds.degradedNoSuccessSeconds / 60} minutes.` };
  }

  const freshSeconds = Math.max(
    thresholds.minimumFreshSeconds,
    (input.samplingIntervalSeconds ?? thresholds.minimumFreshSeconds) * thresholds.normalIntervalToleranceMultiplier,
  );
  const hasRecentAccepted = lastAcceptedAgeSeconds !== null && lastAcceptedAgeSeconds <= freshSeconds;
  const hasRecentFailures = input.recentFailureCount >= thresholds.intermittentFailureCount || input.consecutiveFailures > 0 || input.consecutiveRejects > 0;

  if (hasRecentFailures && (hasRecentAccepted || input.recentSuccessCount > 0)) {
    return { ...base, state: "intermittent", reason: "Recent failures exist, but accepted readings are still arriving." };
  }
  if (hasRecentAccepted) {
    return { ...base, state: "healthy", reason: null };
  }
  if (hasRecentFailures) {
    return { ...base, state: "intermittent", reason: "Recent failures exist, but the sustained failure threshold has not been reached." };
  }
  return { ...base, state: "degraded", reason: "No accepted reading has been recorded yet." };
}
