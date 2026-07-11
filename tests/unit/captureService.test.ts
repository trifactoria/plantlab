import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withCameraLock } from "../../src/lib/cameraLock";
import { CaptureScheduler, type CaptureFn } from "../../src/lib/captureService";
import { prisma } from "../../src/lib/prisma";
import { nextAlignedCaptureTime } from "../../src/lib/schedule";
import { cleanupTestProject, createFakePhoto, createTestProject } from "./helpers/testProject";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

describe("CaptureScheduler", () => {
  const createdProjectIds: Array<{ id: string; directory: string }> = [];

  async function project(overrides: Parameters<typeof createTestProject>[1] = {}) {
    const created = await createTestProject(prisma, overrides);
    createdProjectIds.push({ id: created.id, directory: created.localPhotoDirectory });
    return created;
  }

  afterEach(async () => {
    for (const { id, directory } of createdProjectIds.splice(0)) {
      await cleanupTestProject(prisma, id, directory);
    }
  });

  it("captures multiple due, enabled projects and ignores disabled ones", async () => {
    let now = new Date("2026-07-10T17:00:00Z");
    const startAt = new Date("2026-07-10T16:59:00Z");

    const enabledA = await project({ captureStartAt: startAt, photoIntervalMinutes: 1 });
    const enabledB = await project({ captureStartAt: startAt, photoIntervalMinutes: 1 });
    const disabled = await project({
      captureStartAt: startAt,
      photoIntervalMinutes: 1,
      captureEnabled: false,
    });

    const capturedProjectIds: string[] = [];
    const captureProjectPhoto: CaptureFn = async (projectId) => {
      capturedProjectIds.push(projectId);
      const photo = await createFakePhoto(prisma, projectId);
      return { photo, savedPath: photo.path };
    };

    const scheduler = new CaptureScheduler({
      prisma,
      captureProjectPhoto,
      now: () => now,
      logger: silentLogger(),
    });

    // First tick establishes each project's next aligned target, always in
    // the future - nothing should be captured yet.
    const firstTick = await scheduler.tick();
    expect(firstTick.dueCount).toBe(0);

    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 5);

    const secondTick = await scheduler.tick();

    expect(capturedProjectIds.sort()).toEqual([enabledA.id, enabledB.id].sort());
    expect(secondTick.captures.every((capture) => capture.status === "success")).toBe(true);
    expect(capturedProjectIds).not.toContain(disabled.id);

    const disabledRuns = await prisma.captureRun.count({ where: { projectId: disabled.id } });
    expect(disabledRuns).toBe(0);
  });

  it("records success and failure capture runs, and one project's failure doesn't block another", async () => {
    let now = new Date("2026-07-10T17:00:00Z");
    const startAt = new Date("2026-07-10T16:59:00Z");

    const failing = await project({ captureStartAt: startAt, photoIntervalMinutes: 1 });
    const succeeding = await project({ captureStartAt: startAt, photoIntervalMinutes: 1 });

    const captureProjectPhoto: CaptureFn = async (projectId) => {
      if (projectId === failing.id) {
        throw new Error("simulated camera failure");
      }
      const photo = await createFakePhoto(prisma, projectId);
      return { photo, savedPath: photo.path };
    };

    const scheduler = new CaptureScheduler({ prisma, captureProjectPhoto, now: () => now, logger: silentLogger() });
    await scheduler.tick();

    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 5);
    const tick = await scheduler.tick();

    expect(tick.dueCount).toBe(2);
    const failingResult = tick.captures.find((capture) => capture.projectId === failing.id);
    const succeedingResult = tick.captures.find((capture) => capture.projectId === succeeding.id);

    expect(failingResult?.status).toBe("failed");
    expect(succeedingResult?.status).toBe("success");

    const failingRun = await prisma.captureRun.findFirst({ where: { projectId: failing.id } });
    const succeedingRun = await prisma.captureRun.findFirst({ where: { projectId: succeeding.id } });

    expect(failingRun?.status).toBe("failed");
    expect(failingRun?.errorMessage).toContain("simulated camera failure");
    expect(succeedingRun?.status).toBe("success");
    expect(succeedingRun?.photoId).toBeTruthy();
  });

  it("serializes two due projects that share one camera device, and releases the lock after a failure", async () => {
    let now = new Date("2026-07-10T17:00:00Z");
    const startAt = new Date("2026-07-10T16:59:00Z");
    const sharedDevice = `/dev/video-shared-${randomUUID()}`;

    const first = await project({
      captureStartAt: startAt,
      photoIntervalMinutes: 1,
      cameraDevice: sharedDevice,
    });
    const second = await project({
      captureStartAt: startAt,
      photoIntervalMinutes: 1,
      cameraDevice: sharedDevice,
    });

    const order: string[] = [];
    // The real captureProjectPhoto (src/lib/camera.ts) acquires the shared
    // camera lock itself, so this fake mirrors that contract to verify the
    // scheduler + lock combination actually serializes same-device work.
    const captureProjectPhoto: CaptureFn = async (projectId) =>
      withCameraLock(sharedDevice, async () => {
        order.push(`${projectId}-start`);
        if (projectId === first.id) {
          // First job fails after a short delay; the lock must still release.
          await delay(20);
          order.push(`${projectId}-end`);
          throw new Error("simulated failure on shared camera");
        }

        await delay(1);
        order.push(`${projectId}-end`);
        const photo = await createFakePhoto(prisma, projectId);
        return { photo, savedPath: photo.path };
      });

    const scheduler = new CaptureScheduler({ prisma, captureProjectPhoto, now: () => now, logger: silentLogger() });
    await scheduler.tick();

    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 5);
    const tick = await scheduler.tick();

    expect(tick.dueCount).toBe(2);
    // Because both due projects share a camera, execution must not
    // interleave: one job's start/end pair completes before the next
    // job's start, regardless of which project happened to be created first.
    const firstJobId = order[0].replace("-start", "");
    const otherJobId = firstJobId === first.id ? second.id : first.id;
    expect(order).toEqual([
      `${firstJobId}-start`,
      `${firstJobId}-end`,
      `${otherJobId}-start`,
      `${otherJobId}-end`,
    ]);

    const failingRun = await prisma.captureRun.findFirst({ where: { projectId: first.id } });
    const succeedingRun = await prisma.captureRun.findFirst({ where: { projectId: second.id } });
    expect(failingRun?.status).toBe("failed");
    expect(succeedingRun?.status).toBe("success");
  });

  it("picks up configuration changes (e.g. a shorter interval) without restarting the scheduler", async () => {
    let now = new Date("2026-07-10T17:00:00Z");
    const startAt = now;

    const changing = await project({ captureStartAt: startAt, photoIntervalMinutes: 60 });

    const captureProjectPhoto: CaptureFn = async (projectId) => {
      const photo = await createFakePhoto(prisma, projectId);
      return { photo, savedPath: photo.path };
    };

    const scheduler = new CaptureScheduler({ prisma, captureProjectPhoto, now: () => now, logger: silentLogger() });

    // Establishes a target ~60 minutes out - nothing due a minute later.
    await scheduler.tick();
    now = new Date(now.getTime() + 60_000);
    const tickBeforeChange = await scheduler.tick();
    expect(tickBeforeChange.captures.map((capture) => capture.projectId)).not.toContain(changing.id);

    // Same scheduler instance, no restart - just edit the DB row.
    await prisma.project.update({ where: { id: changing.id }, data: { photoIntervalMinutes: 1 } });

    // Re-tick: the config change must be detected and the target
    // recomputed to align with the new 1-minute interval.
    await scheduler.tick();
    const newTarget = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(newTarget.getTime() + 5);
    const tickAfterChange = await scheduler.tick();

    expect(tickAfterChange.captures.map((capture) => capture.projectId)).toContain(changing.id);
  });

  it("does not schedule ineligible projects (e.g. no camera selected)", async () => {
    let now = new Date("2026-07-10T17:00:00Z");
    const startAt = new Date("2026-07-10T16:59:00Z");

    const noCamera = await project({ captureStartAt: startAt, photoIntervalMinutes: 1, cameraDevice: null });

    const captureProjectPhoto: CaptureFn = async (projectId) => {
      const photo = await createFakePhoto(prisma, projectId);
      return { photo, savedPath: photo.path };
    };

    const scheduler = new CaptureScheduler({ prisma, captureProjectPhoto, now: () => now, logger: silentLogger() });
    await scheduler.tick();

    now = new Date(now.getTime() + 5 * 60_000);
    const tick = await scheduler.tick();

    expect(tick.captures.map((capture) => capture.projectId)).not.toContain(noCamera.id);
  });
});
