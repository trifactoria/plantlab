import type { PrismaClient } from "@prisma/client";
import { POWER_OUTLET_KEYS } from "./powerProtocol";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/powerHistory.ts is server-only operational code.");
}

const MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
const MAX_EVENTS = 5_000;

export type PowerHistoryResult =
  | {
      ok: true;
      status: 200;
      body: {
        node: { id: string; name: string };
        range: { from: string; to: string };
        tracks: PowerHistoryTrack[];
      };
    }
  | { ok: false; status: 400 | 404 | 413; error: string };

export type PowerHistoryTrack = {
  outletId: string;
  outletKey: string;
  label: string;
  enabled: boolean;
  available: boolean;
  initialState: boolean | null;
  gaps: Array<{ from: string; to: string }>;
  segments: Array<{ from: string; to: string; state: boolean }>;
  events: Array<{ at: string; state: boolean; source: string; commandId: string | null }>;
};

export async function getPowerStateHistory(prisma: PrismaClient, nodeName: string, params: URLSearchParams): Promise<PowerHistoryResult> {
  const parsed = parsePowerHistoryParams(params);
  if (!parsed.ok) return parsed;
  const { from, to, outletKeys } = parsed.value;

  const node = await prisma.plantLabNode.findUnique({
    where: { name: nodeName },
    include: { outlets: { orderBy: { key: "asc" } } },
  });
  if (!node) return { ok: false, status: 404, error: `No registered node named "${nodeName}".` };

  const keys = outletKeys.length > 0 ? outletKeys : node.outlets.map((outlet) => outlet.key);
  const outlets = node.outlets
    .filter((outlet) => keys.includes(outlet.key))
    .sort((a, b) => outletSortKey(a.key).localeCompare(outletSortKey(b.key)));

  const eventCount = await prisma.powerStateEvent.count({
    where: { nodeId: node.id, outletKey: { in: keys }, observedAt: { gt: from, lte: to } },
  });
  if (eventCount > MAX_EVENTS) {
    return { ok: false, status: 413, error: `Power history response is too large. Narrow the range or request fewer outlets.` };
  }

  const tracks = await Promise.all(
    outlets.map(async (outlet) => {
      const [prior, events] = await Promise.all([
        prisma.powerStateEvent.findFirst({
          where: { outletId: outlet.id, observedAt: { lte: from } },
          orderBy: { observedAt: "desc" },
        }),
        prisma.powerStateEvent.findMany({
          where: { outletId: outlet.id, observedAt: { gt: from, lte: to } },
          orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }],
        }),
      ]);
      return buildPowerHistoryTrack({
        outlet: { id: outlet.id, key: outlet.key, name: outlet.name, enabled: outlet.enabled, available: outlet.available },
        from,
        to,
        prior,
        events,
      });
    }),
  );

  return {
    ok: true,
    status: 200,
    body: {
      node: { id: node.id, name: node.name },
      range: { from: from.toISOString(), to: to.toISOString() },
      tracks,
    },
  };
}

function buildPowerHistoryTrack(input: {
  outlet: { id: string; key: string; name: string; enabled: boolean; available: boolean };
  from: Date;
  to: Date;
  prior: { observedState: boolean; observedAt: Date } | null;
  events: Array<{ observedState: boolean; observedAt: Date; source: string; commandId: string | null }>;
}): PowerHistoryTrack {
  const gaps: PowerHistoryTrack["gaps"] = [];
  const segments: PowerHistoryTrack["segments"] = [];
  let current = input.prior?.observedState ?? null;
  let cursor = input.from;

  if (current === null) {
    const firstEvent = input.events[0] ?? null;
    gaps.push({
      from: input.from.toISOString(),
      to: (firstEvent?.observedAt ?? input.to).toISOString(),
    });
    if (firstEvent) {
      current = firstEvent.observedState;
      cursor = firstEvent.observedAt;
    }
  }

  for (const event of input.events) {
    if (event.observedAt.getTime() === cursor.getTime() && current === event.observedState) {
      continue;
    }
    if (current !== null && event.observedAt.getTime() > cursor.getTime()) {
      segments.push({ from: cursor.toISOString(), to: event.observedAt.toISOString(), state: current });
    }
    current = event.observedState;
    cursor = event.observedAt;
  }

  if (current !== null && input.to.getTime() > cursor.getTime()) {
    segments.push({ from: cursor.toISOString(), to: input.to.toISOString(), state: current });
  }

  return {
    outletId: input.outlet.id,
    outletKey: input.outlet.key,
    label: input.outlet.name,
    enabled: input.outlet.enabled,
    available: input.outlet.available,
    initialState: input.prior?.observedState ?? null,
    gaps,
    segments,
    events: input.events.map((event) => ({
      at: event.observedAt.toISOString(),
      state: event.observedState,
      source: event.source,
      commandId: event.commandId,
    })),
  };
}

function parsePowerHistoryParams(params: URLSearchParams):
  | { ok: true; value: { from: Date; to: Date; outletKeys: string[] } }
  | { ok: false; status: 400; error: string } {
  const from = parseRequiredDate(params.get("from"), "from");
  if (!from.ok) return from;
  const to = parseRequiredDate(params.get("to"), "to");
  if (!to.ok) return to;
  if (to.value.getTime() <= from.value.getTime()) return { ok: false, status: 400, error: "to must be after from." };
  if (to.value.getTime() - from.value.getTime() > MAX_RANGE_MS) {
    return { ok: false, status: 400, error: "Power history range must be 31 days or shorter." };
  }
  const outletKeys = splitList(params.get("outletKeys"));
  const invalid = outletKeys.filter((key) => !POWER_OUTLET_KEYS.includes(key as (typeof POWER_OUTLET_KEYS)[number]));
  if (invalid.length > 0) return { ok: false, status: 400, error: `Invalid outlet key(s): ${invalid.join(", ")}.` };
  return { ok: true, value: { from: from.value, to: to.value, outletKeys } };
}

function parseRequiredDate(value: string | null, label: string): { ok: true; value: Date } | { ok: false; status: 400; error: string } {
  if (!value) return { ok: false, status: 400, error: `${label} is required.` };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { ok: false, status: 400, error: `${label} must be a valid ISO timestamp.` };
  return { ok: true, value: parsed };
}

function splitList(value: string | null) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function outletSortKey(key: string) {
  const index = POWER_OUTLET_KEYS.indexOf(key as (typeof POWER_OUTLET_KEYS)[number]);
  return `${index === -1 ? 99 : index}:${key}`;
}
