import type { PrismaClient, SensorTestCommand } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/sensorTestProtocol.ts is server-only operational code.");
}

/**
 * Mirrors PowerCommand's lifecycle (src/lib/operations/powerProtocol.ts)
 * almost exactly - same queue/claim/report shape, same stale-claim
 * recovery approach - plus one extra state, "running", because a bounded
 * multi-attempt sensor test takes several seconds to tens of seconds to
 * execute (unlike a near-instant power toggle) and the UI needs a visible
 * state between "claimed" and "done."
 */
export const SENSOR_TEST_STATUSES = ["pending", "claimed", "running", "succeeded", "failed", "expired", "cancelled"] as const;
export type SensorTestStatus = (typeof SENSOR_TEST_STATUSES)[number];

export const MIN_TEST_ATTEMPTS = 1;
export const MAX_TEST_ATTEMPTS = 10;
export const MIN_TEST_INTERVAL_SECONDS = 0;
export const MAX_TEST_INTERVAL_SECONDS = 10;
export const DEFAULT_TEST_ATTEMPTS = 5;
export const DEFAULT_TEST_INTERVAL_SECONDS = 3;

/** Generous relative to a worst-case bounded run (MAX_TEST_ATTEMPTS x (MAX_TEST_INTERVAL_SECONDS + a few seconds of per-attempt read timeout)), so a normal test never hits this. */
const COMMAND_TTL_MS = 3 * 60_000;
/** A command claimed but not yet reported "running" within this long is stuck - see recoverStaleSensorTests(). */
const STALE_CLAIM_MS = 20_000;
/** A command running longer than this without a final report is stuck. */
const STALE_RUNNING_MS = 2 * 60_000;
const MAX_CLAIM_ATTEMPTS = 3;

const STRING_MAX = 200;

function logSensorTestEvent(event: string, meta: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", message: event, ...meta, time: new Date().toISOString() }));
}

export type SensorTestAttemptResult = {
  attempt: number;
  classification: string;
  code: string | null;
  message: string | null;
  temperatureC: number | null;
  humidityPct: number | null;
};

export type SensorTestReport = {
  attemptsCompleted: number;
  acceptedCount: number;
  failedCount: number;
  finalPass: boolean;
  effectiveDriver: string | null;
  configuredGpio: number | null;
  attempts: SensorTestAttemptResult[];
};

export async function createSensorTestCommand(
  prisma: PrismaClient,
  nodeName: string,
  input: { sensorKey: string; attempts?: number; intervalSeconds?: number; requestedBy?: string | null; idempotencyKey?: string | null },
) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName }, include: { sensors: true } });
  if (!node) return { ok: false as const, status: 404, error: `No registered node named "${nodeName}".` };

  const sensor = node.sensors.find((candidate) => candidate.key === input.sensorKey);
  if (!sensor) return { ok: false as const, status: 404, error: `Sensor "${input.sensorKey}" is not known for node "${nodeName}".` };
  if (!sensor.enabled) return { ok: false as const, status: 409, error: `Sensor "${input.sensorKey}" is disabled.` };

  const attempts = input.attempts ?? DEFAULT_TEST_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < MIN_TEST_ATTEMPTS || attempts > MAX_TEST_ATTEMPTS) {
    return { ok: false as const, status: 400, error: `attempts must be an integer between ${MIN_TEST_ATTEMPTS} and ${MAX_TEST_ATTEMPTS}.` };
  }
  const intervalSeconds = input.intervalSeconds ?? DEFAULT_TEST_INTERVAL_SECONDS;
  if (typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds) || intervalSeconds < MIN_TEST_INTERVAL_SECONDS || intervalSeconds > MAX_TEST_INTERVAL_SECONDS) {
    return { ok: false as const, status: 400, error: `intervalSeconds must be a number between ${MIN_TEST_INTERVAL_SECONDS} and ${MAX_TEST_INTERVAL_SECONDS}.` };
  }

  const idempotencyKey = cleanOptionalString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await prisma.sensorTestCommand.findUnique({ where: { nodeId_idempotencyKey: { nodeId: node.id, idempotencyKey } } });
    if (existing) return { ok: true as const, status: 200, command: existing, reused: true };
  }

  // One active test per sensor at a time - see task requirement "prevent
  // multiple simultaneous tests for the same sensor."
  const activeConflict = await prisma.sensorTestCommand.findFirst({
    where: { nodeId: node.id, sensorKey: input.sensorKey, status: { in: ["pending", "claimed", "running"] }, expiresAt: { gt: new Date() } },
    orderBy: { requestedAt: "asc" },
  });
  if (activeConflict) {
    return { ok: false as const, status: 409, error: `Sensor "${input.sensorKey}" already has an active test.`, command: activeConflict };
  }

  const expiresAt = new Date(Date.now() + COMMAND_TTL_MS);
  const command = await prisma.sensorTestCommand.create({
    data: {
      nodeId: node.id,
      sensorKey: input.sensorKey,
      attemptsRequested: attempts,
      intervalSeconds,
      expiresAt,
      idempotencyKey,
      requestedBy: cleanOptionalString(input.requestedBy),
    },
  });
  logSensorTestEvent("sensor test created", { commandId: command.id, node: nodeName, sensorKey: input.sensorKey, attempts, intervalSeconds });
  return { ok: true as const, status: 201, command, reused: false };
}

export type SensorTestCommandPayload = {
  id: string;
  sensorKey: string;
  attemptsRequested: number;
  intervalSeconds: number;
  expiresAt: string;
};

export async function nextSensorTestCommand(prisma: PrismaClient, nodeId: string): Promise<SensorTestCommandPayload | null> {
  await expireAndRecoverSensorTests(prisma, nodeId);
  const command = await prisma.sensorTestCommand.findFirst({
    where: { nodeId, status: "pending", availableAt: { lte: new Date() }, expiresAt: { gt: new Date() } },
    orderBy: { requestedAt: "asc" },
  });
  if (command) {
    logSensorTestEvent("sensor test offered", { commandId: command.id, nodeId, sensorKey: command.sensorKey, elapsedMs: Date.now() - command.requestedAt.getTime() });
  }
  return command
    ? { id: command.id, sensorKey: command.sensorKey, attemptsRequested: command.attemptsRequested, intervalSeconds: command.intervalSeconds, expiresAt: command.expiresAt.toISOString() }
    : null;
}

export async function claimSensorTestCommand(prisma: PrismaClient, nodeId: string, commandId: string) {
  await expireAndRecoverSensorTests(prisma, nodeId);
  const existing = await prisma.sensorTestCommand.findUnique({ where: { id: commandId } });
  if (!existing || existing.nodeId !== nodeId) return null;
  if (existing.status === "claimed" || existing.status === "running") return existing;
  if (existing.status !== "pending" || existing.expiresAt <= new Date()) return null;
  const updated = await prisma.sensorTestCommand.updateMany({
    where: { id: commandId, nodeId, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "claimed", claimedAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (updated.count === 0) return null;
  const claimed = await prisma.sensorTestCommand.findUnique({ where: { id: commandId } });
  if (claimed) {
    logSensorTestEvent("sensor test claimed", { commandId: claimed.id, nodeId, sensorKey: claimed.sensorKey, elapsedMs: Date.now() - claimed.requestedAt.getTime() });
  }
  return claimed;
}

export async function startSensorTestCommand(prisma: PrismaClient, nodeId: string, commandId: string) {
  const existing = await prisma.sensorTestCommand.findUnique({ where: { id: commandId } });
  if (!existing || existing.nodeId !== nodeId) return null;
  if (existing.status === "running") return existing;
  if (existing.status !== "claimed") return null;
  const updated = await prisma.sensorTestCommand.updateMany({
    where: { id: commandId, nodeId, status: "claimed" },
    data: { status: "running", startedAt: new Date() },
  });
  if (updated.count === 0) return null;
  const started = await prisma.sensorTestCommand.findUnique({ where: { id: commandId } });
  if (started) {
    logSensorTestEvent("sensor test running", { commandId: started.id, nodeId, sensorKey: started.sensorKey });
  }
  return started;
}

export async function reportSensorTestCommand(prisma: PrismaClient, nodeId: string, commandId: string, report: SensorTestReport) {
  const command = await prisma.sensorTestCommand.findUnique({ where: { id: commandId } });
  if (!command || command.nodeId !== nodeId) return null;
  if (command.status === "succeeded" || command.status === "failed") return command;
  if (command.status !== "running" && command.status !== "claimed") return null;

  const updated = await prisma.sensorTestCommand.update({
    where: { id: commandId },
    data: {
      status: report.finalPass ? "succeeded" : "failed",
      completedAt: new Date(),
      attemptsCompleted: report.attemptsCompleted,
      acceptedCount: report.acceptedCount,
      failedCount: report.failedCount,
      finalPass: report.finalPass,
      effectiveDriver: report.effectiveDriver,
      configuredGpio: report.configuredGpio,
      attemptsJson: JSON.stringify(report.attempts).slice(0, 20_000),
      errorCode: null,
      errorMessage: null,
    },
  });
  logSensorTestEvent("sensor test completed", {
    commandId: updated.id,
    nodeId,
    sensorKey: updated.sensorKey,
    finalPass: report.finalPass,
    acceptedCount: report.acceptedCount,
    failedCount: report.failedCount,
    elapsedMs: updated.completedAt ? updated.completedAt.getTime() - updated.requestedAt.getTime() : null,
  });
  return updated;
}

export async function failSensorTestCommand(prisma: PrismaClient, nodeId: string, commandId: string, errorCode: string, errorMessage: string) {
  const command = await prisma.sensorTestCommand.findUnique({ where: { id: commandId } });
  if (!command || command.nodeId !== nodeId) return null;
  if (command.status === "failed") return command;
  if (command.status !== "pending" && command.status !== "claimed" && command.status !== "running") return null;

  const updated = await prisma.sensorTestCommand.update({
    where: { id: commandId },
    data: {
      status: "failed",
      completedAt: new Date(),
      errorCode: cleanOptionalString(errorCode) ?? "sensor-test-failed",
      errorMessage: cleanOptionalString(errorMessage),
    },
  });
  logSensorTestEvent("sensor test failed", { commandId: updated.id, nodeId, sensorKey: updated.sensorKey, errorCode: updated.errorCode });
  return updated;
}

export async function getActiveOrLatestSensorTest(prisma: PrismaClient, nodeId: string, sensorKey: string) {
  const active = await prisma.sensorTestCommand.findFirst({
    where: { nodeId, sensorKey, status: { in: ["pending", "claimed", "running"] } },
    orderBy: { requestedAt: "desc" },
  });
  if (active) return active;
  return prisma.sensorTestCommand.findFirst({ where: { nodeId, sensorKey }, orderBy: { requestedAt: "desc" } });
}

export async function listRecentSensorTests(prisma: PrismaClient, nodeId: string, sensorKey: string, limit = 10) {
  return prisma.sensorTestCommand.findMany({ where: { nodeId, sensorKey }, orderBy: { requestedAt: "desc" }, take: limit });
}

export function serializeSensorTestCommand(command: SensorTestCommand) {
  return {
    id: command.id,
    sensorKey: command.sensorKey,
    status: command.status,
    attemptsRequested: command.attemptsRequested,
    intervalSeconds: command.intervalSeconds,
    requestedAt: command.requestedAt.toISOString(),
    claimedAt: command.claimedAt?.toISOString() ?? null,
    startedAt: command.startedAt?.toISOString() ?? null,
    completedAt: command.completedAt?.toISOString() ?? null,
    expiresAt: command.expiresAt.toISOString(),
    attemptsCompleted: command.attemptsCompleted,
    acceptedCount: command.acceptedCount,
    failedCount: command.failedCount,
    finalPass: command.finalPass,
    effectiveDriver: command.effectiveDriver,
    configuredGpio: command.configuredGpio,
    attempts: parseAttemptsJson(command.attemptsJson),
    errorCode: command.errorCode,
    errorMessage: command.errorMessage,
  };
}

function parseAttemptsJson(raw: string | null): SensorTestAttemptResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SensorTestAttemptResult[]) : [];
  } catch {
    return [];
  }
}

/**
 * Same design as recoverStaleClaimedCommands() in powerProtocol.ts: runs on
 * every next/claim poll, so recovery happens automatically as part of
 * normal traffic. A command claimed-but-not-yet-running, or running-too-
 * long, is reopened (redelivered) below MAX_CLAIM_ATTEMPTS, else
 * explicitly failed - "failed" drops out of the active-conflict check in
 * createSensorTestCommand(), so this also bounds how long a stuck test can
 * block a new one for the same sensor.
 */
async function expireAndRecoverSensorTests(prisma: PrismaClient, nodeId: string) {
  const now = new Date();

  const toExpire = await prisma.sensorTestCommand.findMany({
    where: { nodeId, status: { in: ["pending", "claimed", "running"] }, expiresAt: { lte: now } },
  });
  if (toExpire.length > 0) {
    await prisma.sensorTestCommand.updateMany({
      where: { id: { in: toExpire.map((command) => command.id) } },
      data: { status: "expired", completedAt: now, errorCode: "sensor-test-expired", errorMessage: "Sensor test expired before completion." },
    });
    for (const command of toExpire) {
      logSensorTestEvent("sensor test expired", { commandId: command.id, nodeId, sensorKey: command.sensorKey, elapsedMs: now.getTime() - command.requestedAt.getTime() });
    }
  }

  const staleClaimed = await prisma.sensorTestCommand.findMany({
    where: { nodeId, status: "claimed", claimedAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) }, expiresAt: { gt: now } },
  });
  const staleRunning = await prisma.sensorTestCommand.findMany({
    where: { nodeId, status: "running", startedAt: { lte: new Date(now.getTime() - STALE_RUNNING_MS) }, expiresAt: { gt: now } },
  });

  for (const command of [...staleClaimed, ...staleRunning]) {
    if (command.attemptCount < MAX_CLAIM_ATTEMPTS) {
      const updated = await prisma.sensorTestCommand.updateMany({
        where: { id: command.id, status: command.status },
        data: { status: "pending", claimedAt: null, startedAt: null },
      });
      if (updated.count > 0) {
        logSensorTestEvent("sensor test stale-claim recovered", { commandId: command.id, nodeId, sensorKey: command.sensorKey, attemptCount: command.attemptCount });
      }
    } else {
      const updated = await prisma.sensorTestCommand.updateMany({
        where: { id: command.id, status: command.status },
        data: { status: "failed", completedAt: now, errorCode: "sensor-test-stale", errorMessage: "Sensor test was claimed but never completed after multiple attempts." },
      });
      if (updated.count > 0) {
        logSensorTestEvent("sensor test failed", { commandId: command.id, nodeId, sensorKey: command.sensorKey, errorCode: "sensor-test-stale" });
      }
    }
  }
}

function cleanOptionalString(value: unknown, maxLength = STRING_MAX): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
