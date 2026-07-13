import type { PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/powerProtocol.ts is server-only operational code.");
}

export const POWER_ACTIONS = ["on", "off", "pulse", "refresh"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];
export const POWER_COMMAND_STATUSES = ["pending", "claimed", "succeeded", "failed", "expired", "cancelled"] as const;
export const POWER_OUTLET_KEYS = ["fans", "water", "lights"] as const;
export const WATER_MAX_PULSE_SECONDS = 120;

const STATE_BATCH_MAX = 20;
const STRING_MAX = 200;
const ERROR_MAX = 500;

export type PowerOutletStateReport = {
  key: string;
  name: string;
  provider: string;
  providerAlias: string;
  enabled: boolean;
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
      await prisma.nodeOutlet.upsert({
        where: { nodeId_key: { nodeId, key: outlet.key } },
        create: {
          nodeId,
          key: outlet.key,
          name: outlet.name,
          provider: outlet.provider,
          providerAlias: outlet.providerAlias,
          enabled: outlet.enabled,
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
          safetyClass: outlet.safetyClass,
          actualState: outlet.actualState,
          stateObservedAt: outlet.stateObservedAt,
          available: outlet.available,
          lastErrorCode: outlet.lastErrorCode,
          lastErrorMessage: outlet.lastErrorMessage,
        },
      }),
    );
  }
  if (outlets.length > 0) {
    await prisma.plantLabNode.update({ where: { id: nodeId }, data: { updatedAt: now } }).catch(() => undefined);
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

  const durationSeconds = parseCommandDuration(action, outletKey, input.durationSeconds);
  if (!durationSeconds.ok) return durationSeconds;

  if (outlet.safetyClass === "water" && action === "on") {
    return { ok: false as const, status: 400, error: "Water outlets do not permit unbounded ON commands. Use pulse with a bounded duration." };
  }
  if (outletKey === "water" && action === "on") {
    return { ok: false as const, status: 400, error: "Water outlets do not permit unbounded ON commands. Use pulse with a bounded duration." };
  }

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
  return prisma.powerCommand.findUnique({ where: { id: commandId } });
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
  return updated;
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
    safetyClass: optionalString(raw.safetyClass, `outlets[${index}].safetyClass`, 50) ?? (key === "water" ? "water" : "switch"),
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
  await prisma.powerCommand.updateMany({
    where: { nodeId, status: { in: ["pending", "claimed"] }, expiresAt: { lte: new Date() } },
    data: { status: "expired", completedAt: new Date(), errorCode: "power-command-expired", errorMessage: "Power command expired before completion." },
  });
}

function parseCommandDuration(action: PowerAction, outletKey: string, raw: number | null | undefined) {
  if (action !== "pulse") {
    if (raw !== undefined && raw !== null) return { ok: false as const, status: 400, error: "durationSeconds is only valid for pulse commands." };
    return { ok: true as const, value: null };
  }
  if (!Number.isInteger(raw) || typeof raw !== "number") return { ok: false as const, status: 400, error: "pulse commands require integer durationSeconds." };
  if (raw <= 0) return { ok: false as const, status: 400, error: "durationSeconds must be greater than zero." };
  if (raw > WATER_MAX_PULSE_SECONDS) return { ok: false as const, status: 400, error: `durationSeconds must be at most ${WATER_MAX_PULSE_SECONDS}.` };
  if (outletKey !== "water") return { ok: false as const, status: 400, error: "pulse is currently supported only for the water outlet." };
  return { ok: true as const, value: raw };
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
