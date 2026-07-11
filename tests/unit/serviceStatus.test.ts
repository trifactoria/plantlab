import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  computeServiceHealth,
  getProjectCaptureStatus,
  getServiceStatusSnapshot,
  SERVICE_STATUS_ID,
  writeHeartbeat,
} from "../../src/lib/serviceStatus";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

describe("computeServiceHealth", () => {
  it("reports offline when no heartbeat has ever been recorded", () => {
    expect(computeServiceHealth(null)).toBe("offline");
  });

  it("reports running when the heartbeat is recent", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const lastHeartbeat = new Date("2026-07-10T11:59:50Z");

    expect(computeServiceHealth({ lastHeartbeat }, now, 45_000)).toBe("running");
  });

  it("reports stale when the heartbeat is older than the threshold", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const lastHeartbeat = new Date("2026-07-10T11:58:00Z");

    expect(computeServiceHealth({ lastHeartbeat }, now, 45_000)).toBe("stale");
  });
});

describe("service heartbeat persistence", () => {
  beforeEach(async () => {
    await prisma.serviceStatus.deleteMany({ where: { id: SERVICE_STATUS_ID } });
  });

  afterEach(async () => {
    await prisma.serviceStatus.deleteMany({ where: { id: SERVICE_STATUS_ID } });
  });

  it("round-trips through writeHeartbeat and getServiceStatusSnapshot", async () => {
    const startedAt = new Date("2026-07-10T09:00:00Z");
    const now = new Date("2026-07-10T09:05:00Z");

    await writeHeartbeat(prisma, { startedAt, now });
    const snapshot = await getServiceStatusSnapshot(prisma, now);

    expect(snapshot.health).toBe("running");
    expect(snapshot.startedAt).toBe(startedAt.toISOString());
    expect(snapshot.lastHeartbeat).toBe(now.toISOString());
    expect(snapshot.pid).toBe(process.pid);
  });

  it("reports stale once the heartbeat is old enough relative to now", async () => {
    const startedAt = new Date("2026-07-10T09:00:00Z");
    await writeHeartbeat(prisma, { startedAt, now: startedAt });

    const muchLater = new Date(startedAt.getTime() + 10 * 60_000);
    const snapshot = await getServiceStatusSnapshot(prisma, muchLater);

    expect(snapshot.health).toBe("stale");
  });
});

describe("getProjectCaptureStatus", () => {
  it("reports last success and last error from capture run history", async () => {
    const project = await createTestProject(prisma);

    try {
      const now = new Date();
      await prisma.captureRun.create({
        data: {
          projectId: project.id,
          scheduledFor: new Date(now.getTime() - 60_000),
          startedAt: new Date(now.getTime() - 59_000),
          completedAt: new Date(now.getTime() - 58_000),
          status: "success",
          cameraDevice: project.cameraDevice,
        },
      });
      await prisma.captureRun.create({
        data: {
          projectId: project.id,
          scheduledFor: now,
          startedAt: now,
          completedAt: now,
          status: "failed",
          errorMessage: "ffmpeg exited with code 1",
          cameraDevice: project.cameraDevice,
        },
      });

      const status = await getProjectCaptureStatus(prisma, project, now);

      expect(status.captureEnabled).toBe(true);
      expect(status.eligible).toBe(true);
      expect(status.lastSuccessfulCaptureAt).toBeTruthy();
      expect(status.lastError?.message).toBe("ffmpeg exited with code 1");
    } finally {
      await cleanupTestProject(prisma, project.id, project.localPhotoDirectory);
    }
  });

  it("reports ineligible with a reason when no camera is selected", async () => {
    const project = await createTestProject(prisma, { cameraDevice: null });

    try {
      const status = await getProjectCaptureStatus(prisma, project);

      expect(status.eligible).toBe(false);
      expect(status.nextCaptureAt).toBeNull();
      expect(status.errors.some((message) => message.toLowerCase().includes("camera"))).toBe(true);
    } finally {
      await cleanupTestProject(prisma, project.id, project.localPhotoDirectory);
    }
  });
});
