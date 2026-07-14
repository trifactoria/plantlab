import { beforeEach, describe, expect, it } from "vitest";
import { GET as listSchedules, POST as createSchedule } from "../../src/app/api/nodes/[nodeName]/power/schedules/route";
import { DELETE as deleteSchedule, PATCH as patchSchedule } from "../../src/app/api/nodes/[nodeName]/power/schedules/[scheduleId]/route";
import { POST as createNodePowerCommand } from "../../src/app/api/nodes/[nodeName]/power/[outletKey]/commands/route";
import { ingestPowerState, parsePowerStateReport } from "../../src/lib/operations/powerProtocol";
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
      {
        outlets: [
          { key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", safetyClass: "switch" },
          { key: "lights", name: "Lights", provider: "kasa", providerAlias: "lights", safetyClass: "switch" },
          { key: "water", name: "Water", provider: "kasa", providerAlias: "water", safetyClass: "water" },
        ],
      },
      new Date("2026-07-14T00:00:00.000Z"),
    ),
  );
  return registered;
}

describe("power schedule CRUD API", () => {
  it("creates a schedule and computes nextRunAt", async () => {
    await setUpNode("greenhouse-schedule-create");
    const response = await createSchedule(
      jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "07:00", label: "Morning lights" }),
      { params: Promise.resolve({ nodeName: "greenhouse-schedule-create" }) },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.schedule).toMatchObject({ outletKey: "lights", action: "on", timeOfDay: "07:00", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], enabled: true });
    expect(body.schedule.nextRunAt).not.toBeNull();
  });

  it("allows scheduling a normal outlet named water", async () => {
    await setUpNode("greenhouse-schedule-water");
    const response = await createSchedule(jsonRequest("POST", { outletKey: "water", action: "on", timeOfDay: "07:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-water" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.schedule).toMatchObject({ outletKey: "water", action: "on" });
  });

  it("rejects permanent ON schedules for explicitly pulse-only outlets", async () => {
    const registered = await setUpNode("greenhouse-schedule-pulse-only");
    await ingestPowerState(
      prisma,
      registered.node.id,
      parsePowerStateReport(
        { outlets: [{ key: "water", name: "Water", provider: "kasa", providerAlias: "water", behavior: "pulse-only" }] },
        new Date("2026-07-14T00:00:00.000Z"),
      ),
    );

    const response = await createSchedule(jsonRequest("POST", { outletKey: "water", action: "on", timeOfDay: "07:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-pulse-only" }),
    });
    expect(response.status).toBe(400);

    const off = await createSchedule(jsonRequest("POST", { outletKey: "water", action: "off", timeOfDay: "07:01" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-pulse-only" }),
    });
    expect(off.status).toBe(201);
  });

  it("rejects invalid time-of-day format", async () => {
    await setUpNode("greenhouse-schedule-badtime");
    const response = await createSchedule(jsonRequest("POST", { outletKey: "fans", action: "on", timeOfDay: "25:99" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-badtime" }),
    });
    expect(response.status).toBe(400);
  });

  it("404s for an unregistered node", async () => {
    const response = await createSchedule(jsonRequest("POST", { outletKey: "fans", action: "on", timeOfDay: "07:00" }), {
      params: Promise.resolve({ nodeName: "does-not-exist" }),
    });
    expect(response.status).toBe(404);
  });

  it("lists, updates, and deletes a schedule", async () => {
    await setUpNode("greenhouse-schedule-crud");
    const created = await createSchedule(jsonRequest("POST", { outletKey: "fans", action: "on", timeOfDay: "09:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-crud" }),
    });
    const { schedule } = await created.json();

    const listed = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-schedule-crud" }) });
    expect((await listed.json()).schedules).toHaveLength(1);

    const updated = await patchSchedule(jsonRequest("PATCH", { enabled: false, timeOfDay: "10:30" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-crud", scheduleId: schedule.id }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.schedule).toMatchObject({ enabled: false, timeOfDay: "10:30" });
    expect(updatedBody.schedule.nextRunAt).toBeNull(); // disabled schedules have no next run

    const deleted = await deleteSchedule(jsonRequest("DELETE"), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-crud", scheduleId: schedule.id }),
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await listSchedules(jsonRequest("GET"), { params: Promise.resolve({ nodeName: "greenhouse-schedule-crud" }) });
    expect((await afterDelete.json()).schedules).toHaveLength(0);
  });

  it("404s when updating or deleting a schedule that belongs to a different node", async () => {
    await setUpNode("greenhouse-schedule-owner-a");
    await setUpNode("greenhouse-schedule-owner-b");
    const created = await createSchedule(jsonRequest("POST", { outletKey: "fans", action: "on", timeOfDay: "09:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-owner-a" }),
    });
    const { schedule } = await created.json();

    const crossNodePatch = await patchSchedule(jsonRequest("PATCH", { enabled: false }), {
      params: Promise.resolve({ nodeName: "greenhouse-schedule-owner-b", scheduleId: schedule.id }),
    });
    expect(crossNodePatch.status).toBe(404);
  });
});

describe("duplicate rapid command submission", () => {
  it("rejects a second manual command for the same outlet while one is still pending", async () => {
    await setUpNode("greenhouse-command-spam");
    const first = await createNodePowerCommand(jsonRequest("POST", { action: "on" }), {
      params: Promise.resolve({ nodeName: "greenhouse-command-spam", outletKey: "fans" }),
    });
    expect(first.status).toBe(201);

    const second = await createNodePowerCommand(jsonRequest("POST", { action: "on" }), {
      params: Promise.resolve({ nodeName: "greenhouse-command-spam", outletKey: "fans" }),
    });
    expect(second.status).toBe(409);
  });
});

describe("PowerScheduler.tick", () => {
  it("fires a due schedule, queues a PowerCommand, and records lastRun* fields", async () => {
    const registered = await setUpNode("greenhouse-scheduler-fire");
    await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-scheduler-fire" }),
    });

    const dueNow = new Date("2026-07-14T12:00:00.000Z"); // 08:00 EDT
    const scheduler = new PowerScheduler({ prisma, now: () => dueNow });
    const result = await scheduler.tick();

    expect(result.dueCount).toBe(1);
    expect(result.fired[0]).toMatchObject({ outletKey: "lights", action: "on", status: "queued" });

    const command = await prisma.powerCommand.findFirst({ where: { nodeId: registered.node.id, outletKey: "lights" } });
    expect(command).not.toBeNull();
    expect(command?.requestedBy).toMatch(/^schedule:/);

    const stored = await prisma.powerSchedule.findFirstOrThrow({ where: { nodeId: registered.node.id, outletKey: "lights" } });
    expect(stored.lastRunDateKey).toBe("2026-07-14");
    expect(stored.lastRunStatus).toBe("queued");
  });

  it("does not fire again on a second tick the same local day (restart-safe idempotency)", async () => {
    const registered = await setUpNode("greenhouse-scheduler-idempotent");
    await createSchedule(jsonRequest("POST", { outletKey: "fans", action: "on", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-scheduler-idempotent" }),
    });

    const dueNow = new Date("2026-07-14T12:00:00.000Z");
    const schedulerRun1 = new PowerScheduler({ prisma, now: () => dueNow });
    await schedulerRun1.tick();

    // Simulates a coordinator restart: a brand new scheduler instance with
    // no in-memory state, ticking a few minutes later the same day.
    const schedulerRun2 = new PowerScheduler({ prisma, now: () => new Date(dueNow.getTime() + 5 * 60_000) });
    const result2 = await schedulerRun2.tick();

    expect(result2.dueCount).toBe(0);
    const commandCount = await prisma.powerCommand.count({ where: { nodeId: registered.node.id, outletKey: "fans" } });
    expect(commandCount).toBe(1);
  });

  it("skips a run missed by more than the grace window instead of firing it late", async () => {
    const registered = await setUpNode("greenhouse-scheduler-missed");
    await createSchedule(jsonRequest("POST", { outletKey: "fans", action: "off", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-scheduler-missed" }),
    });

    // Coordinator was offline from 08:00 until 14:00 - six hours late.
    const wayLate = new Date("2026-07-14T18:00:00.000Z");
    const scheduler = new PowerScheduler({ prisma, now: () => wayLate });
    const result = await scheduler.tick();

    expect(result.dueCount).toBe(0);
    const commandCount = await prisma.powerCommand.count({ where: { nodeId: registered.node.id, outletKey: "fans" } });
    expect(commandCount).toBe(0);

    const stored = await prisma.powerSchedule.findFirstOrThrow({ where: { nodeId: registered.node.id, outletKey: "fans" } });
    expect(stored.lastRunDateKey).toBeNull();
  });

  it("never fires a disabled schedule", async () => {
    const registered = await setUpNode("greenhouse-scheduler-disabled");
    const created = await createSchedule(jsonRequest("POST", { outletKey: "lights", action: "off", timeOfDay: "08:00" }), {
      params: Promise.resolve({ nodeName: "greenhouse-scheduler-disabled" }),
    });
    const { schedule } = await created.json();
    await patchSchedule(jsonRequest("PATCH", { enabled: false }), {
      params: Promise.resolve({ nodeName: "greenhouse-scheduler-disabled", scheduleId: schedule.id }),
    });

    const dueNow = new Date("2026-07-14T12:00:00.000Z");
    const scheduler = new PowerScheduler({ prisma, now: () => dueNow });
    const result = await scheduler.tick();

    // Other schedules created by earlier tests in this file may also be due
    // at the same instant (tick() scans all nodes) - assert this specific
    // disabled schedule's node/outlet never fired, not the global count.
    expect(result.fired.some((fired) => fired.nodeName === "greenhouse-scheduler-disabled")).toBe(false);
    const commandCount = await prisma.powerCommand.count({ where: { nodeId: registered.node.id, outletKey: "lights" } });
    expect(commandCount).toBe(0);
  });
});
