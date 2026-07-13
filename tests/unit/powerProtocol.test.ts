import { describe, expect, it } from "vitest";
import { POST as postPowerState } from "../../src/app/api/agents/power/state/route";
import { GET as getNextPowerCommand } from "../../src/app/api/agents/power/commands/next/route";
import { POST as claimPowerCommandRoute } from "../../src/app/api/agents/power/commands/[commandId]/claim/route";
import { POST as completePowerCommandRoute } from "../../src/app/api/agents/power/commands/[commandId]/complete/route";
import { GET as getNodePower } from "../../src/app/api/nodes/[nodeName]/power/route";
import { POST as createNodePowerCommand } from "../../src/app/api/nodes/[nodeName]/power/[outletKey]/commands/route";
import {
  createPowerCommand,
  ingestPowerState,
  nextPowerCommand,
  parsePowerStateReport,
  WATER_MAX_PULSE_SECONDS,
} from "../../src/lib/operations/powerProtocol";
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
    stateObservedAt: "2026-07-13T15:30:00.000Z",
    available: true,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function jsonRequest(url: string, body: unknown, token?: string | null) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("power protocol", () => {
  it("upserts authenticated outlet state and exposes latest node power status", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-power-state", role: "greenhouse-node", rotateCredential: true });
    const parsed = parsePowerStateReport({ outlets: [outlet()] }, new Date("2026-07-13T15:31:00.000Z"));

    const result = await ingestPowerState(prisma, registered.node.id, parsed);

    expect(result).toMatchObject({ acceptedOutlets: ["fans"], count: 1 });
    const stored = await prisma.nodeOutlet.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "fans" } } });
    expect(stored.providerAlias).toBe("greenhouse-fans");
    const response = await getNodePower(new Request("http://localhost"), { params: Promise.resolve({ nodeName: "greenhouse-power-state" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outlets[0]).toMatchObject({ key: "fans", actualState: false, available: true });
  });

  it("authenticates the agent state route and rejects nodeName mismatch", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-power-route", role: "greenhouse-node", rotateCredential: true });
    const unauth = await postPowerState(jsonRequest("http://localhost/api/agents/power/state", { nodeName: "greenhouse-power-route", outlets: [outlet()] }, null));
    expect(unauth.status).toBe(401);

    const mismatch = await postPowerState(jsonRequest("http://localhost/api/agents/power/state", { nodeName: "other", outlets: [outlet()] }, registered.credential));
    expect(mismatch.status).toBe(403);

    const ok = await postPowerState(
      jsonRequest("http://localhost/api/agents/power/state", { nodeName: "greenhouse-power-route", outlets: [outlet({ stateObservedAt: new Date().toISOString() })] }, registered.credential),
    );
    expect(ok.status).toBe(200);
  });

  it("creates bounded manual commands and forbids permanent water on", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-power-command", role: "greenhouse-node", rotateCredential: true });
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport(
        {
          outlets: [
            outlet({ key: "fans", name: "Fans", providerAlias: "greenhouse-fans", safetyClass: "switch" }),
            outlet({ key: "water", name: "Water", providerAlias: "greenhouse-water", safetyClass: "water" }),
          ],
        },
        new Date("2026-07-13T15:31:00.000Z"),
      ),
    );

    const fans = await createPowerCommand(prisma, "greenhouse-power-command", { outletKey: "fans", action: "on", idempotencyKey: "same-command" });
    const reusedAgain = await createPowerCommand(prisma, "greenhouse-power-command", { outletKey: "fans", action: "on", idempotencyKey: "same-command" });
    const waterOn = await createPowerCommand(prisma, "greenhouse-power-command", { outletKey: "water", action: "on" });
    const tooLong = await createPowerCommand(prisma, "greenhouse-power-command", { outletKey: "water", action: "pulse", durationSeconds: WATER_MAX_PULSE_SECONDS + 1 });

    expect(fans.ok).toBe(true);
    expect(reusedAgain.ok).toBe(true);
    if (!fans.ok || !reusedAgain.ok) throw new Error("expected idempotent command creation to succeed");
    expect(reusedAgain.status).toBe(200);
    expect(reusedAgain.command.id).toBe(fans.command.id);
    expect(waterOn.ok).toBe(false);
    expect(waterOn.status).toBe(400);
    expect(tooLong.ok).toBe(false);
  });

  it("lets the authenticated agent claim and complete a command idempotently", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-power-agent", role: "greenhouse-node", rotateCredential: true });
    await ingestPowerState(prisma, registered.node.id, parsePowerStateReport({ outlets: [outlet()] }, new Date("2026-07-13T15:31:00.000Z")));
    await createPowerCommand(prisma, "greenhouse-power-agent", { outletKey: "fans", action: "on" });

    const next = await nextPowerCommand(prisma, registered.node.id);
    expect(next).toMatchObject({ outletKey: "fans", action: "on" });

    const nextRoute = await getNextPowerCommand(new Request("http://localhost", { headers: { authorization: `Bearer ${registered.credential}` } }));
    expect(nextRoute.status).toBe(200);
    const nextBody = await nextRoute.json();
    const commandId = nextBody.command.id;

    const claimed = await claimPowerCommandRoute(new Request("http://localhost", { method: "POST", headers: { authorization: `Bearer ${registered.credential}` } }), {
      params: Promise.resolve({ commandId }),
    });
    expect(claimed.status).toBe(200);

    const completed = await completePowerCommandRoute(
      jsonRequest("http://localhost", { actualState: true, stateObservedAt: new Date().toISOString() }, registered.credential),
      { params: Promise.resolve({ commandId }) },
    );
    expect(completed.status).toBe(200);
    const stored = await prisma.powerCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(stored.status).toBe("succeeded");
    const outletState = await prisma.nodeOutlet.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "fans" } } });
    expect(outletState.actualState).toBe(true);
  });

  it("queues commands through the node API", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-power-node-api", role: "greenhouse-node", rotateCredential: true });
    await ingestPowerState(prisma, registered.node.id, parsePowerStateReport({ outlets: [outlet()] }, new Date("2026-07-13T15:31:00.000Z")));

    const response = await createNodePowerCommand(jsonRequest("http://localhost", { action: "off" }, null), {
      params: Promise.resolve({ nodeName: "greenhouse-power-node-api", outletKey: "fans" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.command).toMatchObject({ outletKey: "fans", action: "off" });
  });
});
