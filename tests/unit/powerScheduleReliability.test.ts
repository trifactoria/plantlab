import { beforeEach, describe, expect, it } from "vitest";
import { GET as listSchedules, POST as createSchedule } from "../../src/app/api/nodes/[nodeName]/power/schedules/route";
import { PATCH as patchSchedule } from "../../src/app/api/nodes/[nodeName]/power/schedules/[scheduleId]/route";
import {
  claimPowerCommand,
  completePowerCommand,
  createPowerCommand,
  failPowerCommand,
  MAX_CLAIM_ATTEMPTS,
  nextPowerCommand,
  STALE_CLAIM_MS,
  parsePowerStateReport,
  ingestPowerState,
} from "../../src/lib/operations/powerProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { PowerScheduler } from "../../src/lib/operations/powerSchedule";
import { prisma } from "../../src/lib/prisma";

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://localhost", {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setUpNode(name: string) {
  const registered = await registerOrRotateNode(prisma, { name, role: "greenhouse-node", rotateCredential: true });
  await ingestPowerState(
    prisma,
    registered.node.id,
    parsePowerStateReport(
      { outlets: [{ key: "lights", name: "Lights", provider: "kasa", providerAlias: "lights", safetyClass: "switch" }] },
      new Date("2026-07-14T00:00:00.000Z"),
    ),
  );
  return registered;
}

async function scheduleFor(nodeId: string, outletKey: string) {
  return prisma.powerSchedule.findFirstOrThrow({ where: { nodeId, outletKey } });
}

describe("root-cause regression: editing a schedule after it fired", () => {
  it("resets run-tracking so the edited action still fires later the same local day", async () => {
    // Reproduces the 2026-07-14 incident: a "lights ON" schedule fires,
    // then gets edited in place to "lights OFF" a couple minutes later
    // (exactly what the UI's Edit flow does) - the edited OFF action must
    // still be eligible to fire today, not silently suppressed because
    // lastRunDateKey already matches today from the earlier ON firing.
    const registered = await setUpNode("greenhouse-regression-edit");
    const created = await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "01:24" }), {
      params: Promise.resolve({ nodeName: "greenhouse-regression-edit" }),
    });
    const { schedule } = await created.json();

    const fireTime = new Date("2026-07-14T05:24:32.000Z"); // 01:24:32 EDT
    const scheduler = new PowerScheduler({ prisma, now: () => fireTime });
    const firstTick = await scheduler.tick();
    expect(firstTick.fired.some((f) => f.scheduleId === schedule.id && f.status === "queued")).toBe(true);

    const afterFirstFire = await scheduleFor(registered.node.id, "lights");
    expect(afterFirstFire.lastRunDateKey).toBe("2026-07-14");
    expect(afterFirstFire.action).toBe("on");

    // Matches the real incident: the edge agent claims and completes the ON
    // command within a few seconds (fast, healthy path) well before the
    // schedule gets edited.
    await claimPowerCommand(prisma, registered.node.id, afterFirstFire.lastCommandId!);
    await completePowerCommand(prisma, registered.node.id, afterFirstFire.lastCommandId!, { actualState: true, stateObservedAt: new Date() });

    // Edit in place to OFF at 01:26, ~33s later - same schedule row, same day.
    const edited = await patchSchedule(jsonRequest("PATCH", { action: "off", timeOfDay: "01:26" }), {
      params: Promise.resolve({ nodeName: "greenhouse-regression-edit", scheduleId: schedule.id }),
    });
    expect(edited.status).toBe(200);
    const editedBody = await edited.json();
    expect(editedBody.schedule.action).toBe("off");
    expect(editedBody.schedule.nextRunAt).not.toBeNull(); // eligible again today, not stuck until tomorrow

    const afterEdit = await scheduleFor(registered.node.id, "lights");
    expect(afterEdit.lastRunDateKey).toBeNull();
    expect(afterEdit.lastCommandId).toBeNull();

    // A later tick at 01:26 - the edited OFF action must fire.
    const laterScheduler = new PowerScheduler({ prisma, now: () => new Date("2026-07-14T05:26:05.000Z") });
    const thirdTick = await laterScheduler.tick();
    const offFired = thirdTick.fired.find((f) => f.scheduleId === schedule.id);
    expect(offFired).toMatchObject({ status: "queued", action: "off" });

    const offCommand = await prisma.powerCommand.findFirst({ where: { nodeId: registered.node.id, outletKey: "lights", action: "off" } });
    expect(offCommand).not.toBeNull();
  });

  it("does not reset run-tracking for edits that don't change due-relevant fields", async () => {
    const registered = await setUpNode("greenhouse-regression-label-edit");
    const created = await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-regression-label-edit" }),
    });
    const { schedule } = await created.json();

    const scheduler = new PowerScheduler({ prisma, now: () => new Date("2026-07-14T12:00:00.000Z") });
    await scheduler.tick();
    const afterFire = await scheduleFor(registered.node.id, "lights");
    expect(afterFire.lastRunDateKey).toBe("2026-07-14");

    await patchSchedule(jsonRequest("PATCH", { label: "Morning lights" }), {
      params: Promise.resolve({ nodeName: "greenhouse-regression-label-edit", scheduleId: schedule.id }),
    });

    const afterLabelEdit = await scheduleFor(registered.node.id, "lights");
    expect(afterLabelEdit.lastRunDateKey).toBe("2026-07-14");
    expect(afterLabelEdit.lastCommandId).toBe(afterFire.lastCommandId);
  });
});

describe("schedule-to-command lifecycle reconciliation", () => {
  it("reflects pending -> claimed -> succeeded through the schedule API, not a static 'queued' label", async () => {
    const registered = await setUpNode("greenhouse-lifecycle");
    await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-lifecycle" }),
    });
    const scheduler = new PowerScheduler({ prisma, now: () => new Date("2026-07-14T12:00:00.000Z") });
    await scheduler.tick();

    const afterQueue = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-lifecycle" }) });
    const queuedSchedule = (await afterQueue.json()).schedules[0];
    expect(queuedSchedule.lastCommand.status).toBe("pending");
    expect(queuedSchedule.lastCommand.requestedAt).not.toBeNull();
    expect(queuedSchedule.lastCommand.claimedAt).toBeNull();

    const commandId = queuedSchedule.lastCommand.id;
    await claimPowerCommand(prisma, registered.node.id, commandId);
    const afterClaim = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-lifecycle" }) });
    const claimedSchedule = (await afterClaim.json()).schedules[0];
    expect(claimedSchedule.lastCommand.status).toBe("claimed");
    expect(claimedSchedule.lastCommand.claimedAt).not.toBeNull();

    await completePowerCommand(prisma, registered.node.id, commandId, { actualState: true, stateObservedAt: new Date() });
    const afterComplete = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-lifecycle" }) });
    const succeededSchedule = (await afterComplete.json()).schedules[0];
    expect(succeededSchedule.lastCommand.status).toBe("succeeded");
    expect(succeededSchedule.lastCommand.completedAt).not.toBeNull();
    expect(succeededSchedule.lastCommand.actualState).toBe(true);
  });

  it("shows failed with the error message when the edge reports failure", async () => {
    const registered = await setUpNode("greenhouse-lifecycle-failed");
    await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-lifecycle-failed" }),
    });
    const scheduler = new PowerScheduler({ prisma, now: () => new Date("2026-07-14T12:00:00.000Z") });
    await scheduler.tick();

    const schedule = await scheduleFor(registered.node.id, "lights");
    await claimPowerCommand(prisma, registered.node.id, schedule.lastCommandId!);
    await failPowerCommand(prisma, registered.node.id, schedule.lastCommandId!, { errorCode: "power-connection-timeout", errorMessage: "Timed out connecting to Kasa device." });

    const listed = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-lifecycle-failed" }) });
    const failed = (await listed.json()).schedules[0];
    expect(failed.lastCommand.status).toBe("failed");
    expect(failed.lastCommand.errorMessage).toBe("Timed out connecting to Kasa device.");
  });

  it("shows expired when the command's TTL passes before being claimed", async () => {
    const registered = await setUpNode("greenhouse-lifecycle-expired");
    await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-lifecycle-expired" }),
    });
    const scheduler = new PowerScheduler({ prisma, now: () => new Date("2026-07-14T12:00:00.000Z") });
    await scheduler.tick();
    const schedule = await scheduleFor(registered.node.id, "lights");

    await prisma.powerCommand.update({ where: { id: schedule.lastCommandId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await nextPowerCommand(prisma, registered.node.id); // triggers expireOldPowerCommands as a side effect, same as a real edge poll

    const listed = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-lifecycle-expired" }) });
    const expired = (await listed.json()).schedules[0];
    expect(expired.lastCommand.status).toBe("expired");
  });
});

describe("stale-claimed-command recovery", () => {
  it("reopens a command claimed too long without completing so it is redelivered", async () => {
    const registered = await setUpNode("greenhouse-stale-claim");
    const command = await createPowerCommand(prisma, "greenhouse-stale-claim", { outletKey: "lights", action: "on" });
    if (!command.ok) throw new Error("expected command creation to succeed");
    await claimPowerCommand(prisma, registered.node.id, command.command.id);

    // Simulate the edge process crashing right after claiming - back-date
    // claimedAt past the stale-claim threshold, well within the 5-minute
    // hard expiry.
    await prisma.powerCommand.update({
      where: { id: command.command.id },
      data: { claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) },
    });

    const redelivered = await nextPowerCommand(prisma, registered.node.id);
    expect(redelivered).toMatchObject({ id: command.command.id, outletKey: "lights", action: "on" });

    const stored = await prisma.powerCommand.findUniqueOrThrow({ where: { id: command.command.id } });
    expect(stored.status).toBe("pending");
    expect(stored.claimedAt).toBeNull();
  });

  it("explicitly fails a command after it has been claimed and gone stale MAX_CLAIM_ATTEMPTS times, and stops blocking new commands for that outlet", async () => {
    const registered = await setUpNode("greenhouse-stale-claim-exhausted");
    const command = await createPowerCommand(prisma, "greenhouse-stale-claim-exhausted", { outletKey: "lights", action: "on" });
    if (!command.ok) throw new Error("expected command creation to succeed");

    // Simulate MAX_CLAIM_ATTEMPTS worth of claim-then-go-stale cycles.
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      await nextPowerCommand(prisma, registered.node.id); // recovery pass runs first each cycle
      await claimPowerCommand(prisma, registered.node.id, command.command.id);
      await prisma.powerCommand.update({
        where: { id: command.command.id },
        data: { claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) },
      });
    }

    // One more recovery pass should now explicitly fail it (attemptCount reached the limit).
    await nextPowerCommand(prisma, registered.node.id);
    const stored = await prisma.powerCommand.findUniqueOrThrow({ where: { id: command.command.id } });
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("power-command-stale-claim");

    // A broken command that is now terminally "failed" must not block a
    // brand new command for the same outlet - this is the queue-starvation
    // bound: at most STALE_CLAIM_MS * MAX_CLAIM_ATTEMPTS, not the full
    // 5-minute hard expiry.
    const nextAttempt = await createPowerCommand(prisma, "greenhouse-stale-claim-exhausted", { outletKey: "lights", action: "off" });
    expect(nextAttempt.ok).toBe(true);
  });

  it("does not disturb a command claimed well within the stale-claim window", async () => {
    const registered = await setUpNode("greenhouse-stale-claim-healthy");
    const command = await createPowerCommand(prisma, "greenhouse-stale-claim-healthy", { outletKey: "lights", action: "on" });
    if (!command.ok) throw new Error("expected command creation to succeed");
    await claimPowerCommand(prisma, registered.node.id, command.command.id);

    await nextPowerCommand(prisma, registered.node.id); // recovery pass runs, should be a no-op here
    const stored = await prisma.powerCommand.findUniqueOrThrow({ where: { id: command.command.id } });
    expect(stored.status).toBe("claimed");
  });
});

describe("normal scheduled command latency", () => {
  it("stays within a bounded, small latency end to end when the edge responds immediately", async () => {
    const registered = await setUpNode("greenhouse-latency");
    await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-latency" }),
    });

    const dueAt = new Date("2026-07-14T12:00:00.000Z");
    const scheduler = new PowerScheduler({ prisma, now: () => dueAt });
    await scheduler.tick();

    const schedule = await scheduleFor(registered.node.id, "lights");
    const command = await prisma.powerCommand.findUniqueOrThrow({ where: { id: schedule.lastCommandId! } });
    // The command must be immediately claimable (available now, not delayed).
    expect(command.availableAt.getTime()).toBeLessThanOrEqual(dueAt.getTime());
    expect(command.status).toBe("pending");

    await claimPowerCommand(prisma, registered.node.id, command.id);
    await completePowerCommand(prisma, registered.node.id, command.id, { actualState: true, stateObservedAt: new Date() });

    const finalSchedule = await scheduleFor(registered.node.id, "lights");
    const finalCommand = await prisma.powerCommand.findUniqueOrThrow({ where: { id: finalSchedule.lastCommandId! } });
    expect(finalCommand.status).toBe("succeeded");
  });
});
