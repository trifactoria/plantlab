import { describe, expect, it } from "vitest";
import { evaluateSensorHealth } from "../../src/lib/hardware/sensorHealth";

const now = new Date("2026-07-15T12:00:00.000Z");

function input(overrides = {}) {
  return {
    nodeOnline: true,
    enabled: true,
    configuredActive: true,
    retired: false,
    now,
    samplingIntervalSeconds: 60,
    lastAcceptedAt: new Date(now.getTime() - 30_000),
    lastAttemptAt: new Date(now.getTime() - 10_000),
    recentSuccessCount: 1,
    recentFailureCount: 0,
    consecutiveFailures: 0,
    consecutiveRejects: 0,
    failureDurationSeconds: null,
    ...overrides,
  };
}

describe("evaluateSensorHealth", () => {
  it("keeps one isolated miss intermittent instead of failed", () => {
    const health = evaluateSensorHealth(input({ recentFailureCount: 1, consecutiveFailures: 1 }));
    expect(health.state).toBe("intermittent");
  });

  it("classifies alternating success/failure as intermittent", () => {
    const health = evaluateSensorHealth(input({ recentSuccessCount: 3, recentFailureCount: 2, consecutiveFailures: 0 }));
    expect(health.state).toBe("intermittent");
  });

  it("does not degrade before three minutes without success", () => {
    const health = evaluateSensorHealth(input({ lastAcceptedAt: new Date(now.getTime() - 2 * 60_000), recentSuccessCount: 0, recentFailureCount: 1 }));
    expect(health.state).toBe("intermittent");
  });

  it("degrades at three minutes without success", () => {
    const health = evaluateSensorHealth(input({ lastAcceptedAt: new Date(now.getTime() - 3 * 60_000), recentSuccessCount: 0, recentFailureCount: 3 }));
    expect(health.state).toBe("degraded");
  });

  it("fails at five minutes without success", () => {
    const health = evaluateSensorHealth(input({ lastAcceptedAt: new Date(now.getTime() - 5 * 60_000), recentSuccessCount: 0, recentFailureCount: 5 }));
    expect(health.state).toBe("failed");
  });

  it("reports node offline", () => {
    expect(evaluateSensorHealth(input({ nodeOnline: false })).state).toBe("node-offline");
  });

  it("represents retired and disabled sensors without calling them failed", () => {
    expect(evaluateSensorHealth(input({ retired: true })).state).toBe("degraded");
    expect(evaluateSensorHealth(input({ enabled: false })).state).toBe("degraded");
  });

  it("returns healthy after recovery", () => {
    const health = evaluateSensorHealth(input({ recentSuccessCount: 2, recentFailureCount: 0, consecutiveFailures: 0, lastAcceptedAt: new Date(now.getTime() - 5_000) }));
    expect(health.state).toBe("healthy");
  });

  it("handles rejected hard-bound data followed by accepted data as intermittent", () => {
    const health = evaluateSensorHealth(input({ recentSuccessCount: 1, recentFailureCount: 1, consecutiveRejects: 1, lastAcceptedAt: new Date(now.getTime() - 20_000) }));
    expect(health.state).toBe("intermittent");
  });
});
