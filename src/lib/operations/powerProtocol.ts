import type { Prisma, PrismaClient } from "@prisma/client";
import {
  canUsePermanentOff,
  canUsePermanentOn,
  canUsePulse,
  outletBehaviorOrDefault,
  normalizeOutletBehavior,
  type OutletBehavior,
} from "../outletBehavior";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/powerProtocol.ts is server-only operational code.");
}

export const POWER_ACTIONS = ["on", "off", "pulse", "refresh"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];
export const POWER_COMMAND_STATUSES = ["pending", "claimed", "succeeded", "failed", "expired", "cancelled"] as const;
export const POWER_OUTLET_KEYS = ["fans", "water", "lights"] as const;
export const POWER_STATE_EVENT_SOURCES = ["telemetry", "command-verification", "startup", "manual-refresh", "unknown"] as const;
export const MAX_PULSE_SECONDS = 120;
export const WATER_MAX_PULSE_SECONDS = MAX_PULSE_SECONDS;

const STATE_BATCH_MAX = 20;
const STRING_MAX = 200;
const ERROR_MAX = 500;

/**
 * A command claimed longer than this without completing is treated as
 * stuck (crashed edge process, lost completion upload, or a claim response
 * the edge never actually received) and proactively recovered - see
 * recoverStaleClaimedCommands(). Deliberately much tighter than the
 * 5-minute hard expiresAt bound: normal end-to-end latency observed in
 * production is ~3-5 seconds, so 45 seconds already represents a large
 * margin above worst-case healthy execution (Kasa's own driver timeout is
 * bounded at 8s x up to 2 connect attempts, plus a few bounded HTTP round
 * trips) before assuming something went wrong.
 */
export const STALE_CLAIM_MS = 45_000;
/** After this many claim attempts without a successful completion, stop retrying and fail explicitly rather than keep re-offering it - see recoverStaleClaimedCommands(). */
export const MAX_CLAIM_ATTEMPTS = 3;

function logPowerEvent(event: string, meta: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", message: event, ...meta, time: new Date().toISOString() }));
}

export type PowerOutletStateReport = {
  key: string;
  name: string;
  provider: string;
  providerAlias: string;
  enabled: boolean;
  behavior: OutletBehavior;
  safetyClass: string;
  actualState: boolean | null;
  stateObservedAt: Date | null;
  available: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type PowerCommandPayload = {
  id: string;
  outletKey: string;
  action: PowerAction;
  durationSeconds: number | null;
  expiresAt: string;
};

export type PowerCommandResult = {
  actualState?: boolean | null;
  stateObservedAt?: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type PowerStateEventSource = (typeof POWER_STATE_EVENT_SOURCES)[number];

export function parsePowerStateReport(raw: unknown, now = new Date()): PowerOutletStateReport[] {
  if (!isRecord(raw)) throw new Error("Request body must be a JSON object.");
  if (!Array.isArray(raw.outlets)) throw new Error("outlets must be an array.");
  if (raw.outlets.length > STATE_BATCH_MAX) throw new Error(`outlets must contain at most ${STATE_BATCH_MAX} entries.`);
  return raw.outlets.map((outlet, index) => parseOutletState(outlet, index, now));
}

export async function ingestPowerState(prisma: PrismaClient, nodeId: string, outlets: PowerOutletStateReport[]) {
  const now = new Date();
  const upserted = [];
  for (const outlet of outlets) {
    upserted.push(
      await prisma.$transaction(async (tx) => {
        const updated = await tx.nodeOutlet.upsert({
          where: { nodeId_key: { nodeId, key: outlet.key } },
          create: {
            nodeId,
            key: outlet.key,
            name: outlet.name,
            provider: outlet.provider,
            providerAlias: outlet.providerAlias,
            enabled: outlet.enabled,
            behavior: outlet.behavior,
            safetyClass: outlet.safetyClass,
            actualState: outlet.actualState,
            stateObservedAt: outlet.stateObservedAt,
            available: outlet.available,
            lastErrorCode: outlet.lastErrorCode,
            lastErrorMessage: outlet.lastErrorMessage,
          },
          update: {
            name: outlet.name,
            provider: outlet.provider,
            providerAlias: outlet.providerAlias,
            enabled: outlet.enabled,
            behavior: outlet.behavior,
            safetyClass: outlet.safetyClass,
            actualState: outlet.actualState,
            stateObservedAt: outlet.stateObservedAt,
            available: outlet.available,
            lastErrorCode: outlet.lastErrorCode,
            lastErrorMessage: outlet.lastErrorMessage,
          },
        });
        await recordObservedPowerStateEvent(tx, {
          nodeId,
          outletId: updated.id,
          outletKey: updated.key,
          observedState: outlet.actualState,
          observedAt: outlet.stateObservedAt ?? now,
          source: "telemetry",
        });
        return updated;
      }),
    );
  }
  if (outlets.length > 0) {
    await prisma.plantLabNode.update({ where: { id: nodeId }, data: { updatedAt: now, powerStateRefreshRequestedAt: null } }).catch(() => undefined);
  }
  return { acceptedOutlets: upserted.map((outlet) => outlet.key), count: upserted.length };
}

export async function createPowerCommand(
  prisma: PrismaClient,
  nodeName: string,
  input: { outletKey: string; action: string; durationSeconds?: number | null; idempotencyKey?: string | null; requestedBy?: string | null },
) {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: { outlets: true },
  });
  if (!node) return { ok: false as const, status: 404, error: `No registered node named "${nodeName}".` };

  const outletKey = normalizeOutletKey(input.outletKey);
  const action = normalizeAction(input.action);
  if (!outletKey) return { ok: false as const, status: 400, error: "Invalid outlet key." };
  if (!action) return { ok: false as const, status: 400, error: "Invalid power action." };

  const outlet = node.outlets.find((candidate) => candidate.key === outletKey);
  if (!outlet) return { ok: false as const, status: 404, error: `Outlet "${outletKey}" is not known for node "${nodeName}".` };
  if (!outlet.enabled) return { ok: false as const, status: 409, error: `Outlet "${outletKey}" is disabled.` };

  const behavior = outletBehaviorOrDefault(outlet.behavior);
  const behaviorError = validateActionForBehavior(action, behavior);
  if (behaviorError) return behaviorError;

  const durationSeconds = parseCommandDuration(action, input.durationSeconds);
  if (!durationSeconds.ok) return durationSeconds;

  const idempotencyKey = cleanOptionalString(input.idempotencyKey, "idempotencyKey", 120);
  if (idempotencyKey) {
    const existing = await prisma.powerCommand.findUnique({ where: { nodeId_idempotencyKey: { nodeId: node.id, idempotencyKey } } });
    if (existing) return { ok: true as const, status: 200, command: existing, reused: true };
  }

  const activeConflict = await prisma.powerCommand.findFirst({
    where: {
      nodeId: node.id,
      outletKey,
      status: { in: ["pending", "claimed"] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { requestedAt: "asc" },
  });
  if (activeConflict) {
    return { ok: false as const, status: 409, error: `Outlet "${outletKey}" already has an active command.`, command: activeConflict };
  }

  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const command = await prisma.powerCommand.create({
    data: {
      nodeId: node.id,
      outletId: outlet.id,
      outletKey,
      action,
      durationSeconds: durationSeconds.value,
      expiresAt,
      idempotencyKey,
      requestedBy: cleanOptionalString(input.requestedBy, "requestedBy", 120),
    },
  });
  return { ok: true as const, status: 201, command, reused: false };
}

export async function nextPowerCommand(prisma: PrismaClient, nodeId: string): Promise<PowerCommandPayload | null> {
  await expireOldPowerCommands(prisma, nodeId);
  const command = await prisma.powerCommand.findFirst({
    where: { nodeId, status: "pending", availableAt: { lte: new Date() }, expiresAt: { gt: new Date() } },
    orderBy: { requestedAt: "asc" },
  });
  if (command) {
    logPowerEvent("command offered", {
      commandId: command.id,
      nodeId,
      outletKey: command.outletKey,
      action: command.action,
      elapsedMs: Date.now() - command.requestedAt.getTime(),
    });
  }
  return command ? serializePowerCommand(command) : null;
}

export async function claimPowerCommand(prisma: PrismaClient, nodeId: string, commandId: string) {
  await expireOldPowerCommands(prisma, nodeId);
  const existing = await prisma.powerCommand.findUnique({ where: { id: commandId } });
  if (!existing || existing.nodeId !== nodeId) return null;
  if (existing.status === "claimed") return existing;
  if (existing.status !== "pending" || existing.expiresAt <= new Date()) return null;
  const updated = await prisma.powerCommand.updateMany({
    where: { id: commandId, nodeId, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "claimed", claimedAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (updated.count === 0) return null;
  const claimed = await prisma.powerCommand.findUnique({ where: { id: commandId } });
  if (claimed) {
    logPowerEvent("command claimed", {
      commandId: claimed.id,
      nodeId,
      outletKey: claimed.outletKey,
      action: claimed.action,
      attemptCount: claimed.attemptCount,
      elapsedMs: Date.now() - claimed.requestedAt.getTime(),
    });
  }
  return claimed;
}

export async function completePowerCommand(prisma: PrismaClient, nodeId: string, commandId: string, result: PowerCommandResult) {
  const command = await prisma.powerCommand.findUnique({ where: { id: commandId } });
  if (!command || command.nodeId !== nodeId) return null;
  if (command.status === "succeeded") return command;
  if (command.status !== "claimed") return null;
  const stateObservedAt = result.stateObservedAt ?? new Date();
  const updated = await prisma.powerCommand.update({
    where: { id: commandId },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      actualState: result.actualState ?? null,
      stateObservedAt,
      errorCode: null,
      errorMessage: null,
    },
  });
  const outlet = await prisma.nodeOutlet.findUnique({ where: { nodeId_key: { nodeId, key: command.outletKey } } });
  await prisma.nodeOutlet.updateMany({
    where: { nodeId, key: command.outletKey },
    data: {
      actualState: result.actualState ?? undefined,
      stateObservedAt,
      available: true,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  if (outlet) {
    await recordObservedPowerStateEvent(prisma, {
      nodeId,
      outletId: outlet.id,
      outletKey: command.outletKey,
      observedState: result.actualState ?? null,
      observedAt: stateObservedAt,
      source: "command-verification",
      commandId,
    });
  }
  logPowerEvent("command completed", {
    commandId: updated.id,
    nodeId,
    outletKey: updated.outletKey,
    action: updated.action,
    actualState: updated.actualState,
    elapsedMs: updated.completedAt ? updated.completedAt.getTime() - updated.requestedAt.getTime() : null,
  });
  return updated;
}

export async function failPowerCommand(prisma: PrismaClient, nodeId: string, commandId: string, result: PowerCommandResult) {
  const command = await prisma.powerCommand.findUnique({ where: { id: commandId } });
  if (!command || command.nodeId !== nodeId) return null;
  if (command.status === "failed") return command;
  if (command.status !== "pending" && command.status !== "claimed") return null;
  const stateObservedAt = result.stateObservedAt ?? new Date();
  const errorCode = cleanOptionalString(result.errorCode, "errorCode", STRING_MAX) ?? "power-command-failed";
  const errorMessage = cleanOptionalString(result.errorMessage, "errorMessage", ERROR_MAX);
  const updated = await prisma.powerCommand.update({
    where: { id: commandId },
    data: {
      status: "failed",
      completedAt: new Date(),
      actualState: result.actualState ?? null,
      stateObservedAt,
      errorCode,
      errorMessage,
    },
  });
  const outlet = await prisma.nodeOutlet.findUnique({ where: { nodeId_key: { nodeId, key: command.outletKey } } });
  await prisma.nodeOutlet.updateMany({
    where: { nodeId, key: command.outletKey },
    data: {
      actualState: result.actualState ?? undefined,
      stateObservedAt,
      available: result.actualState === undefined ? false : true,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
    },
  });
  if (outlet) {
    await recordObservedPowerStateEvent(prisma, {
      nodeId,
      outletId: outlet.id,
      outletKey: command.outletKey,
      observedState: result.actualState ?? null,
      observedAt: stateObservedAt,
      source: "command-verification",
      commandId,
    });
  }
  logPowerEvent("command failed", {
    commandId: updated.id,
    nodeId,
    outletKey: updated.outletKey,
    action: updated.action,
    errorCode,
    elapsedMs: updated.completedAt ? updated.completedAt.getTime() - updated.requestedAt.getTime() : null,
  });
  return updated;
}

async function recordObservedPowerStateEvent(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    nodeId: string;
    outletId: string;
    outletKey: string;
    observedState: boolean | null | undefined;
    observedAt: Date;
    source: PowerStateEventSource;
    commandId?: string | null;
  },
) {
  if (typeof input.observedState !== "boolean") return null;
  const latest = await prisma.powerStateEvent.findFirst({
    where: { outletId: input.outletId },
    orderBy: { observedAt: "desc" },
  });
  if (latest) {
    if (input.observedAt.getTime() <= latest.observedAt.getTime()) return null;
    if (latest.observedState === input.observedState) return null;
  }
  return prisma.powerStateEvent.create({
    data: {
      nodeId: input.nodeId,
      outletId: input.outletId,
      outletKey: input.outletKey,
      observedState: input.observedState,
      observedAt: input.observedAt,
      source: input.source,
      commandId: input.commandId ?? null,
    },
  });
}

export async function getLatestPowerStatus(prisma: PrismaClient, nodeName: string) {
  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: {
      outlets: { orderBy: { key: "asc" } },
      powerCommands: {
        where: { status: { in: ["pending", "claimed"] }, expiresAt: { gt: new Date() } },
        orderBy: { requestedAt: "asc" },
      },
    },
  });
  if (!node) return null;
  return {
    node: { id: node.id, name: node.name, role: node.role },
    outlets: node.outlets.map((outlet) => {
      const pending = node.powerCommands.find((command) => command.outletKey === outlet.key) ?? null;
      return {
        key: outlet.key,
        name: outlet.name,
        provider: outlet.provider,
        providerAlias: outlet.providerAlias,
        enabled: outlet.enabled,
        behavior: outletBehaviorOrDefault(outlet.behavior),
        safetyClass: outlet.safetyClass,
        actualState: outlet.actualState,
        stateObservedAt: outlet.stateObservedAt?.toISOString() ?? null,
        available: outlet.available,
        pendingCommand: pending
          ? {
              id: pending.id,
              action: pending.action,
              durationSeconds: pending.durationSeconds,
              status: pending.status,
              requestedAt: pending.requestedAt.toISOString(),
              expiresAt: pending.expiresAt.toISOString(),
            }
          : null,
        lastErrorCode: outlet.lastErrorCode,
        lastErrorMessage: outlet.lastErrorMessage,
      };
    }),
  };
}

/** Mirrors requestCameraInventoryRefresh() in agentProtocol.ts - asks the agent to re-upload outlet state on its next poll instead of waiting for the routine ~60s interval. */
export async function requestPowerStateRefresh(prisma: PrismaClient, nodeName: string) {
  return prisma.plantLabNode.update({
    where: { name: nodeName },
    data: { powerStateRefreshRequestedAt: new Date() },
  });
}

export async function getPowerStateRefreshRequest(prisma: PrismaClient, nodeId: string) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({
    where: { id: nodeId },
    select: { powerStateRefreshRequestedAt: true },
  });
  return node.powerStateRefreshRequestedAt;
}

function parseOutletState(raw: unknown, index: number, now: Date): PowerOutletStateReport {
  if (!isRecord(raw)) throw new Error(`outlets[${index}] must be an object.`);
  const key = requiredString(raw.key, `outlets[${index}].key`, 80);
  if (!POWER_OUTLET_KEYS.includes(key as (typeof POWER_OUTLET_KEYS)[number])) {
    throw new Error(`outlets[${index}].key must be one of ${POWER_OUTLET_KEYS.join(", ")}.`);
  }
  const stateObservedAt = raw.stateObservedAt === undefined || raw.stateObservedAt === null ? null : parseTimestamp(raw.stateObservedAt, `outlets[${index}].stateObservedAt`, now);
  if (raw.actualState !== undefined && raw.actualState !== null && typeof raw.actualState !== "boolean") {
    throw new Error(`outlets[${index}].actualState must be a boolean or null.`);
  }
  if (raw.available !== undefined && typeof raw.available !== "boolean") {
    throw new Error(`outlets[${index}].available must be a boolean when present.`);
  }
  return {
    key,
    name: requiredString(raw.name, `outlets[${index}].name`, STRING_MAX),
    provider: requiredString(raw.provider, `outlets[${index}].provider`, 50),
    providerAlias: requiredString(raw.providerAlias, `outlets[${index}].providerAlias`, STRING_MAX),
    enabled: raw.enabled === undefined ? true : requireBoolean(raw.enabled, `outlets[${index}].enabled`),
    behavior: parseBehavior(raw.behavior, `outlets[${index}].behavior`),
    safetyClass: optionalString(raw.safetyClass, `outlets[${index}].safetyClass`, 50) ?? "switch",
    actualState: raw.actualState === undefined ? null : raw.actualState,
    stateObservedAt,
    available: raw.available === undefined ? raw.actualState !== null && raw.actualState !== undefined : raw.available,
    lastErrorCode: optionalString(raw.lastErrorCode, `outlets[${index}].lastErrorCode`, STRING_MAX),
    lastErrorMessage: optionalString(raw.lastErrorMessage, `outlets[${index}].lastErrorMessage`, ERROR_MAX),
  };
}

function serializePowerCommand(command: { id: string; outletKey: string; action: string; durationSeconds: number | null; expiresAt: Date }): PowerCommandPayload {
  return {
    id: command.id,
    outletKey: command.outletKey,
    action: command.action as PowerAction,
    durationSeconds: command.durationSeconds,
    expiresAt: command.expiresAt.toISOString(),
  };
}

async function expireOldPowerCommands(prisma: PrismaClient, nodeId: string) {
  const now = new Date();

  const toExpire = await prisma.powerCommand.findMany({
    where: { nodeId, status: { in: ["pending", "claimed"] }, expiresAt: { lte: now } },
  });
  if (toExpire.length > 0) {
    await prisma.powerCommand.updateMany({
      where: { id: { in: toExpire.map((command) => command.id) } },
      data: { status: "expired", completedAt: now, errorCode: "power-command-expired", errorMessage: "Power command expired before completion." },
    });
    for (const command of toExpire) {
      logPowerEvent("command expired", {
        commandId: command.id,
        nodeId,
        outletKey: command.outletKey,
        action: command.action,
        elapsedMs: now.getTime() - command.requestedAt.getTime(),
      });
    }
  }

  await recoverStaleClaimedCommands(prisma, nodeId, now);
}

/**
 * Recovers commands stuck in "claimed" - an edge process that claimed a
 * command then crashed, restarted, or lost the completion upload before
 * ever calling complete/fail. Runs on every next/claim poll (see call
 * sites above), so recovery happens automatically as part of normal
 * traffic - no separate cron/poller needed. Below MAX_CLAIM_ATTEMPTS the
 * command is reopened as "pending" so the next poll (from this node or,
 * after a restart, a fresh process) redelivers it; a Kasa on/off toggle is
 * idempotent, so a rare double-delivery race with a slow-but-still-alive
 * claimer is a harmless duplicate, not a correctness risk. At/after the
 * limit it is explicitly failed instead - "failed" is not part of the
 * active-conflict check in createPowerCommand(), so this also bounds how
 * long one broken command can block later commands for the same outlet
 * (at most STALE_CLAIM_MS * MAX_CLAIM_ATTEMPTS, well under the 5-minute
 * hard expiry).
 */
async function recoverStaleClaimedCommands(prisma: PrismaClient, nodeId: string, now: Date) {
  const staleClaimed = await prisma.powerCommand.findMany({
    where: { nodeId, status: "claimed", claimedAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) }, expiresAt: { gt: now } },
  });

  for (const command of staleClaimed) {
    if (command.attemptCount < MAX_CLAIM_ATTEMPTS) {
      const updated = await prisma.powerCommand.updateMany({
        where: { id: command.id, status: "claimed" },
        data: { status: "pending", claimedAt: null },
      });
      if (updated.count > 0) {
        logPowerEvent("command stale-claim recovered", {
          commandId: command.id,
          nodeId,
          outletKey: command.outletKey,
          action: command.action,
          attemptCount: command.attemptCount,
          claimedForMs: now.getTime() - (command.claimedAt?.getTime() ?? now.getTime()),
        });
      }
    } else {
      const updated = await prisma.powerCommand.updateMany({
        where: { id: command.id, status: "claimed" },
        data: {
          status: "failed",
          completedAt: now,
          errorCode: "power-command-stale-claim",
          errorMessage: "Command was claimed but never completed after multiple attempts.",
        },
      });
      if (updated.count > 0) {
        await prisma.nodeOutlet.updateMany({
          where: { nodeId, key: command.outletKey },
          data: { available: false, lastErrorCode: "power-command-stale-claim", lastErrorMessage: "Command was claimed but never completed after multiple attempts." },
        });
        logPowerEvent("command failed", {
          commandId: command.id,
          nodeId,
          outletKey: command.outletKey,
          action: command.action,
          errorCode: "power-command-stale-claim",
          attemptCount: command.attemptCount,
        });
      }
    }
  }
}

function parseCommandDuration(action: PowerAction, raw: number | null | undefined) {
  if (action !== "pulse") {
    if (raw !== undefined && raw !== null) return { ok: false as const, status: 400, error: "durationSeconds is only valid for pulse commands." };
    return { ok: true as const, value: null };
  }
  if (!Number.isInteger(raw) || typeof raw !== "number") return { ok: false as const, status: 400, error: "pulse commands require integer durationSeconds." };
  if (raw <= 0) return { ok: false as const, status: 400, error: "durationSeconds must be greater than zero." };
  if (raw > MAX_PULSE_SECONDS) return { ok: false as const, status: 400, error: `durationSeconds must be at most ${MAX_PULSE_SECONDS}.` };
  return { ok: true as const, value: raw };
}

function validateActionForBehavior(action: PowerAction, behavior: OutletBehavior) {
  if (action === "on" && !canUsePermanentOn(behavior)) {
    return { ok: false as const, status: 400, error: `Outlet behavior "${behavior}" does not permit unbounded ON commands. Use pulse with a bounded duration when supported.` };
  }
  if (action === "off" && !canUsePermanentOff(behavior)) {
    return { ok: false as const, status: 400, error: `Outlet behavior "${behavior}" does not permit OFF commands.` };
  }
  if (action === "pulse" && !canUsePulse(behavior)) {
    return { ok: false as const, status: 400, error: `Outlet behavior "${behavior}" does not permit pulse commands.` };
  }
  return null;
}

function normalizeAction(value: unknown): PowerAction | null {
  return typeof value === "string" && POWER_ACTIONS.includes(value as PowerAction) ? (value as PowerAction) : null;
}

function normalizeOutletKey(value: unknown): string | null {
  return typeof value === "string" && POWER_OUTLET_KEYS.includes(value as (typeof POWER_OUTLET_KEYS)[number]) ? value : null;
}

function parseTimestamp(value: unknown, label: string, now: Date): Date {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid ISO 8601 timestamp.`);
  if (parsed.getTime() - now.getTime() > 5 * 60_000) throw new Error(`${label} is too far in the future.`);
  return parsed;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  const parsed = optionalString(value, label, maxLength);
  if (!parsed) throw new Error(`${label} is required.`);
  return parsed;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

function parseBehavior(value: unknown, label: string): OutletBehavior {
  if (value === undefined || value === null || value === "") return outletBehaviorOrDefault(value);
  const parsed = normalizeOutletBehavior(value);
  if (!parsed) throw new Error(`${label} must be one of normal, pulse-only.`);
  return parsed;
}

function cleanOptionalString(value: unknown, label: string, maxLength: number): string | null {
  return optionalString(value, label, maxLength);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
