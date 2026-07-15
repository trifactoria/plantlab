import { afterEach, describe, expect, it } from "vitest";
import { CaptureSourceScheduler, type CaptureSourceFn, type FanOutFn } from "../../src/lib/captureSourceService";
import { updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { attachNodeCamera } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";
import { nextAlignedCaptureTime } from "../../src/lib/schedule";
import { cleanupTestCaptureSource, createTestCaptureSource } from "./helpers/testCaptureSource";
import { cleanupTestProject, createFakePhoto, createTestProject } from "./helpers/testProject";

function silentLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

describe("CaptureSourceScheduler", () => {
  const sources: Array<{ id: string; directory: string }> = [];
  const projects: Array<{ id: string; directory: string }> = [];
  const nodeNames: string[] = [];

  afterEach(async () => {
    for (const { id, directory } of sources.splice(0)) {
      await cleanupTestCaptureSource(prisma, id, directory);
    }
    for (const { id, directory } of projects.splice(0)) {
      await cleanupTestProject(prisma, id, directory);
    }
    for (const name of nodeNames.splice(0)) {
      await prisma.plantLabNode.deleteMany({ where: { name } });
    }
  });

  async function makeSource(overrides: Parameters<typeof createTestCaptureSource>[1] = {}) {
    const source = await createTestCaptureSource(prisma, overrides);
    sources.push({ id: source.id, directory: source.captureDirectory });
    return source;
  }

  async function makeProject(overrides: Parameters<typeof createTestProject>[1] = {}) {
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null, ...overrides });
    projects.push({ id: project.id, directory: project.localPhotoDirectory });
    return project;
  }

  async function makeRemoteSource() {
    const nodeName = `vitest-source-scheduler-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const registered = await registerOrRotateNode(prisma, { name: nodeName, role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: `usb:046d:0825:${nodeName}`,
        devicePath: "/dev/video0",
        name: "Remote Camera",
        vendorId: "046d",
        productId: "0825",
        serial: nodeName,
        physicalPath: `pci-0000/${nodeName}`,
        formats: [{ pixelFormat: "mjpeg", description: "MJPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
    ]);
    const attached = await attachNodeCamera(prisma, {
      nodeName,
      stableId: `usb:046d:0825:${nodeName}`,
      newCaptureSourceName: `${nodeName} source`,
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
    });
    sources.push({ id: attached.captureSource.id, directory: attached.captureSource.captureDirectory });
    return attached;
  }

  it("captures a due source exactly once and fans out, never once per subscribing project", async () => {
    let now = new Date("2026-07-11T17:00:00Z");
    const startAt = new Date("2026-07-11T16:59:00Z");
    const source = await makeSource({ captureStartAt: startAt, photoIntervalMinutes: 1 });
    const projectA = await makeProject();
    const projectB = await makeProject();

    const captureCalls: string[] = [];
    const captureSourcePhoto: CaptureSourceFn = async (captureSourceId, options) => {
      captureCalls.push(captureSourceId);
      const sourceCapture = await prisma.sourceCapture.create({
        data: {
          captureSourceId,
          timestamp: now,
          scheduledFor: options?.scheduledFor ?? null,
          originalPath: `/tmp/${captureSourceId}-${Date.now()}.jpg`,
          originalWidth: 100,
          originalHeight: 100,
          workingWidth: 100,
          workingHeight: 100,
          pixelFormat: "mjpeg",
        },
      });
      return { sourceCapture, savedPath: sourceCapture.originalPath, alreadyExisted: false };
    };

    const photoA = await createFakePhoto(prisma, projectA.id);
    const photoB = await createFakePhoto(prisma, projectB.id);
    const runViewportFanOut: FanOutFn = async (sourceCaptureId) => ({
      sourceCaptureId,
      sourceWidth: 100,
      sourceHeight: 100,
      projectResults: [
        { projectId: projectA.id, projectName: "A", viewportId: "v-a", status: "success", photoId: photoA.id },
        { projectId: projectB.id, projectName: "B", viewportId: "v-b", status: "success", photoId: photoB.id },
      ],
    });

    const scheduler = new CaptureSourceScheduler({
      prisma,
      captureSourcePhoto,
      runViewportFanOut,
      now: () => now,
      logger: silentLogger(),
    });

    await scheduler.tick();
    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 5);
    const tick = await scheduler.tick();

    expect(tick.dueCount).toBe(1);
    expect(captureCalls).toEqual([source.id]);
    expect(tick.captures[0].status).toBe("success");
    expect(tick.captures[0].fanOut?.projectResults).toHaveLength(2);

    const runs = await prisma.captureRun.findMany({ where: { cameraDevice: source.cameraDevice } });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.projectId).sort()).toEqual([projectA.id, projectB.id].sort());
    expect(runs.every((r) => r.status === "success")).toBe(true);
  });

  it("skips fan-out entirely when captureSourcePhoto reports the slot already exists (idempotent retry)", async () => {
    // captureSourcePhoto's own unique(captureSourceId, scheduledFor)-backed
    // idempotency is covered at the DB level in sourceCapture.test.ts; this
    // verifies the scheduler's *response* to that signal - it must never
    // run fan-out twice for one already-completed slot.
    let now = new Date("2026-07-11T17:00:00Z");
    const startAt = new Date("2026-07-11T16:59:00Z");
    const source = await makeSource({ captureStartAt: startAt, photoIntervalMinutes: 1 });

    let fanOutRuns = 0;
    const existingCapture = await prisma.sourceCapture.create({
      data: {
        captureSourceId: source.id,
        timestamp: startAt,
        scheduledFor: null,
        originalPath: "/tmp/already-captured.jpg",
        originalWidth: 100,
        originalHeight: 100,
        workingWidth: 100,
        workingHeight: 100,
        pixelFormat: "mjpeg",
      },
    });

    const captureSourcePhoto: CaptureSourceFn = async () => ({
      sourceCapture: existingCapture,
      savedPath: "/tmp/already-captured.jpg",
      alreadyExisted: true,
    });

    const runViewportFanOut: FanOutFn = async (sourceCaptureId) => {
      fanOutRuns += 1;
      return { sourceCaptureId, sourceWidth: 100, sourceHeight: 100, projectResults: [] };
    };

    const scheduler = new CaptureSourceScheduler({
      prisma,
      captureSourcePhoto,
      runViewportFanOut,
      now: () => now,
      logger: silentLogger(),
    });

    await scheduler.tick();
    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 5);
    const tick = await scheduler.tick();

    expect(tick.dueCount).toBe(1);
    expect(tick.captures[0].status).toBe("skipped");
    expect(tick.captures[0].sourceCaptureId).toBe(existingCapture.id);
    expect(fanOutRuns).toBe(0);

    // A skipped slot creates no CaptureRun rows - there is nothing new to report.
    const runs = await prisma.captureRun.findMany({ where: { cameraDevice: source.cameraDevice } });
    expect(runs).toHaveLength(0);
  });

  it("does not fall back to coordinator-local capture when a remote assignment is unavailable", async () => {
    let now = new Date("2026-07-11T17:00:00Z");
    const startAt = new Date("2026-07-11T16:59:00Z");
    const attached = await makeRemoteSource();
    await prisma.captureSource.update({
      where: { id: attached.captureSource.id },
      data: { captureStartAt: startAt, photoIntervalMinutes: 1 },
    });
    await prisma.nodeCamera.update({ where: { id: attached.camera.id }, data: { available: false } });

    const captureSourcePhoto: CaptureSourceFn = async () => {
      throw new Error("remote sources must not fall back to coordinator-local capture");
    };
    const runViewportFanOut: FanOutFn = async (sourceCaptureId) => ({
      sourceCaptureId,
      sourceWidth: 0,
      sourceHeight: 0,
      projectResults: [],
    });

    const scheduler = new CaptureSourceScheduler({ prisma, captureSourcePhoto, runViewportFanOut, now: () => now, logger: silentLogger() });
    await scheduler.tick();
    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 5);
    const tick = await scheduler.tick();

    expect(tick.dueCount).toBe(1);
    expect(tick.captures[0]).toMatchObject({
      captureSourceId: attached.captureSource.id,
      status: "failed",
      errorMessage: "Remote camera assignment is not currently available for scheduled capture.",
    });
    await expect(prisma.agentCaptureJob.count({ where: { captureSourceId: attached.captureSource.id } })).resolves.toBe(0);
    await expect(prisma.sourceCapture.count({ where: { captureSourceId: attached.captureSource.id } })).resolves.toBe(0);
  });

  it("does not schedule an inactive capture source", async () => {
    let now = new Date("2026-07-11T17:00:00Z");
    const startAt = new Date("2026-07-11T16:59:00Z");
    await makeSource({ captureStartAt: startAt, photoIntervalMinutes: 1, active: false });

    const captureSourcePhoto: CaptureSourceFn = async () => {
      throw new Error("should not be called for an inactive source");
    };
    const runViewportFanOut: FanOutFn = async (sourceCaptureId) => ({
      sourceCaptureId,
      sourceWidth: 0,
      sourceHeight: 0,
      projectResults: [],
    });

    const scheduler = new CaptureSourceScheduler({ prisma, captureSourcePhoto, runViewportFanOut, now: () => now, logger: silentLogger() });
    await scheduler.tick();
    now = new Date(now.getTime() + 5 * 60_000);
    const tick = await scheduler.tick();

    expect(tick.dueCount).toBe(0);
  });
});
