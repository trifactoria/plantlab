import { describe, expect, it } from "vitest";
import { GET as getPowerHistoryRoute } from "../../src/app/api/nodes/[nodeName]/power/history/route";
import {
  claimPowerCommand,
  completePowerCommand,
  createPowerCommand,
  ingestPowerState,
  parsePowerStateReport,
} from "../../src/lib/operations/powerProtocol";
import { getPowerStateHistory } from "../../src/lib/operations/powerHistory";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

function outlet(overrides: Record<string, unknown> = {}) {
  return {
    key: "fans",
    name: "Fans",
    provider: "kasa",
    providerAlias: "greenhouse-fans",
    enabled: true,
    safetyClass: "switch",
    actualState: false,
    stateObservedAt: "2026-07-13T15:00:00.000Z",
    available: true,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

async function node(name: string) {
  return registerOrRotateNode(prisma, { name, role: "greenhouse-node", rotateCredential: true });
}

describe("power state history", () => {
  it("records an initial observed state and skips duplicate unchanged telemetry", async () => {
    const registered = await node("power-history-initial");
    await ingestPowerState(prisma, registered.node.id, parsePowerStateReport({ outlets: [outlet()] }, new Date("2026-07-13T15:01:00.000Z")));
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport({ outlets: [outlet({ stateObservedAt: "2026-07-13T15:02:00.000Z" })] }, new Date("2026-07-13T15:03:00.000Z")),
    );

    const events = await prisma.powerStateEvent.findMany({ where: { nodeId: registered.node.id, outletKey: "fans" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ observedState: false, source: "telemetry", commandId: null });
  });

  it("records observed transitions in order and builds range segments", async () => {
    const registered = await node("power-history-transition");
    await ingestPowerState(prisma, registered.node.id, parsePowerStateReport({ outlets: [outlet()] }, new Date("2026-07-13T15:01:00.000Z")));
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport({ outlets: [outlet({ actualState: true, stateObservedAt: "2026-07-13T16:00:00.000Z" })] }, new Date("2026-07-13T16:01:00.000Z")),
    );
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport({ outlets: [outlet({ actualState: false, stateObservedAt: "2026-07-13T17:00:00.000Z" })] }, new Date("2026-07-13T17:01:00.000Z")),
    );

    const history = await getPowerStateHistory(
      prisma,
      "power-history-transition",
      new URLSearchParams({
        from: "2026-07-13T15:30:00.000Z",
        to: "2026-07-13T17:30:00.000Z",
        outletKeys: "fans",
      }),
    );

    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error(history.error);
    expect(history.body.tracks[0].initialState).toBe(false);
    expect(history.body.tracks[0].events.map((event) => [event.at, event.state])).toEqual([
      ["2026-07-13T16:00:00.000Z", true],
      ["2026-07-13T17:00:00.000Z", false],
    ]);
    expect(history.body.tracks[0].segments).toEqual([
      { from: "2026-07-13T15:30:00.000Z", to: "2026-07-13T16:00:00.000Z", state: false },
      { from: "2026-07-13T16:00:00.000Z", to: "2026-07-13T17:00:00.000Z", state: true },
      { from: "2026-07-13T17:00:00.000Z", to: "2026-07-13T17:30:00.000Z", state: false },
    ]);
  });

  it("associates command-verified transitions with the command", async () => {
    const registered = await node("power-history-command");
    await ingestPowerState(prisma, registered.node.id, parsePowerStateReport({ outlets: [outlet()] }, new Date("2026-07-13T15:01:00.000Z")));
    const created = await createPowerCommand(prisma, "power-history-command", { outletKey: "fans", action: "on" });
    if (!created.ok) throw new Error(created.error);
    await claimPowerCommand(prisma, registered.node.id, created.command.id);
    await completePowerCommand(prisma, registered.node.id, created.command.id, {
      actualState: true,
      stateObservedAt: new Date("2026-07-13T15:05:00.000Z"),
    });

    const events = await prisma.powerStateEvent.findMany({ where: { nodeId: registered.node.id, outletKey: "fans" }, orderBy: { observedAt: "asc" } });
    expect(events.map((event) => ({ state: event.observedState, source: event.source, commandId: event.commandId }))).toEqual([
      { state: false, source: "telemetry", commandId: null },
      { state: true, source: "command-verification", commandId: created.command.id },
    ]);
  });

  it("keeps the unknown pre-range state explicit and does not invent OFF", async () => {
    const registered = await node("power-history-unknown");
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport({ outlets: [outlet({ actualState: true, stateObservedAt: "2026-07-13T16:00:00.000Z" })] }, new Date("2026-07-13T16:01:00.000Z")),
    );

    const history = await getPowerStateHistory(
      prisma,
      "power-history-unknown",
      new URLSearchParams({ from: "2026-07-13T15:00:00.000Z", to: "2026-07-13T17:00:00.000Z", outletKeys: "fans" }),
    );

    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error(history.error);
    expect(history.body.tracks[0].initialState).toBeNull();
    expect(history.body.tracks[0].gaps).toEqual([{ from: "2026-07-13T15:00:00.000Z", to: "2026-07-13T16:00:00.000Z" }]);
    expect(history.body.tracks[0].segments).toEqual([{ from: "2026-07-13T16:00:00.000Z", to: "2026-07-13T17:00:00.000Z", state: true }]);
  });

  it("supports multiple outlets, disabled outlets, and route validation", async () => {
    const registered = await node("power-history-multi");
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport(
        {
          outlets: [
            outlet({ key: "fans", name: "Fans", providerAlias: "greenhouse-fans", actualState: true }),
            outlet({ key: "lights", name: "Lights", providerAlias: "greenhouse-lights", actualState: false, enabled: false }),
          ],
        },
        new Date("2026-07-13T15:01:00.000Z"),
      ),
    );

    const ok = await getPowerHistoryRoute(new Request("http://localhost?from=2026-07-13T14:00:00.000Z&to=2026-07-13T16:00:00.000Z&outletKeys=lights,fans"), {
      params: Promise.resolve({ nodeName: "power-history-multi" }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.tracks.map((track: { outletKey: string; enabled: boolean }) => [track.outletKey, track.enabled])).toEqual([
      ["fans", true],
      ["lights", false],
    ]);

    const invalid = await getPowerHistoryRoute(new Request("http://localhost?from=bad&to=2026-07-13T16:00:00.000Z"), {
      params: Promise.resolve({ nodeName: "power-history-multi" }),
    });
    expect(invalid.status).toBe(400);
  });
});
