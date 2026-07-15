import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureSourceScheduler, type CaptureSourceFn, type FanOutFn } from "../../src/lib/captureSourceService";
import { updateCaptureSourceConfig } from "../../src/lib/operations/captureSourceConfig";
import { getProjectCameraSummary } from "../../src/lib/operations/projectCameraSummary";
import { captureProjectManually } from "../../src/lib/operations/projectManualCapture";
import { attachNodeCamera } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { prisma } from "../../src/lib/prisma";
import { nextAlignedCaptureTime } from "../../src/lib/schedule";
import { runViewportFanOut } from "../../src/lib/viewportFanOut";
import { cleanupTestCaptureSource, createRealSourceCapture, createTestCaptureSource } from "./helpers/testCaptureSource";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

function silentLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

async function createNode(role: Parameters<typeof registerOrRotateNode>[1]["role"] = "greenhouse-node") {
  const registered = await registerOrRotateNode(prisma, {
    name: `vitest-cadence-${randomUUID()}`,
    role,
    rotateCredential: true,
  });
  return registered.node;
}

async function createOutlet(nodeId: string, overrides: { actualState?: boolean | null; available?: boolean } = {}) {
  return prisma.nodeOutlet.create({
    data: {
      nodeId,
      key: `lights-${randomUUID()}`,
      name: "Shelf lights",
      provider: "mock",
      providerAlias: "mock-lights",
      actualState: overrides.actualState ?? false,
      stateObservedAt: new Date("2026-07-15T12:00:00.000Z"),
      available: overrides.available ?? true,
    },
  });
}

async function createRemoteSource(role: Parameters<typeof registerOrRotateNode>[1]["role"] = "greenhouse-node") {
  const node = await createNode(role);
  await updateCameraInventory(prisma, node.id, [
    {
      stableId: `usb:046d:0825:${node.name}`,
      devicePath: "/dev/video0",
      name: "Remote Camera",
      vendorId: "046d",
      productId: "0825",
      serial: node.name,
      physicalPath: `pci-0000/${node.name}`,
      formats: [{ pixelFormat: "mjpeg", description: "MJPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
    },
  ]);
  return attachNodeCamera(prisma, {
    nodeName: node.name,
    stableId: `usb:046d:0825:${node.name}`,
    newCaptureSourceName: `${node.name} source`,
    width: 1280,
    height: 720,
    inputFormat: "mjpeg",
  });
}

async function bindProjectToSource(projectId: string, captureSourceId: string, input: { interval: number; anchor: Date }) {
  return prisma.projectViewport.create({
    data: {
      projectId,
      captureSourceId,
      cropX: 0,
      cropY: 0,
      cropWidth: 1,
      cropHeight: 1,
      effectiveFrom: input.anchor,
      active: true,
      samplingEnabled: true,
      samplingIntervalMinutes: input.interval,
      samplingAnchorAt: input.anchor,
    },
  });
}

describe("capture cadence, illumination policy, and project sampling", () => {
  const sourceDirs: Array<{ id: string; directory: string }> = [];
  const projectDirs: Array<{ id: string; directory: string }> = [];
  const extraDirs: string[] = [];
  const nodeNames: string[] = [];

  afterEach(async () => {
    for (const { id, directory } of projectDirs.splice(0)) {
      await cleanupTestProject(prisma, id, directory);
    }
    for (const { id, directory } of sourceDirs.splice(0)) {
      await cleanupTestCaptureSource(prisma, id, directory);
    }
    for (const directory of extraDirs.splice(0)) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const name of nodeNames.splice(0)) {
      await prisma.plantLabNode.deleteMany({ where: { name } });
    }
  });

  it("new greenhouse camera sources default to 15 minutes and 08:00-00:00 America/New_York", async () => {
    const attached = await createRemoteSource("greenhouse-node");
    nodeNames.push(attached.node.name);
    sourceDirs.push({ id: attached.captureSource.id, directory: attached.captureSource.captureDirectory });

    expect(attached.captureSource).toMatchObject({
      photoIntervalMinutes: 15,
      timeZone: "America/New_York",
      captureWindowEnabled: true,
      captureWindowStartMinutes: 8 * 60,
      captureWindowEndMinutes: 0,
    });
  });

  it("preserves existing explicit source schedules during configuration edits", async () => {
    const source = await createTestCaptureSource(prisma, {
      photoIntervalMinutes: 45,
      captureStartAt: new Date("2026-07-15T12:00:00.000Z"),
    });
    sourceDirs.push({ id: source.id, directory: source.captureDirectory });

    const updated = await updateCaptureSourceConfig(prisma, source.id, { name: "Renamed source" });

    expect(updated.name).toBe("Renamed source");
    expect(updated.photoIntervalMinutes).toBe(45);
    expect(updated.captureWindowEnabled).toBe(false);
  });

  it("only-while-on skips OFF and unknown illumination without recording camera failure", async () => {
    let now = new Date("2026-07-15T12:00:00.000Z");
    const startAt = new Date("2026-07-15T11:59:00.000Z");
    const node = await createNode();
    nodeNames.push(node.name);
    const outlet = await createOutlet(node.id, { actualState: false });
    const source = await createTestCaptureSource(prisma, { captureStartAt: startAt, photoIntervalMinutes: 1 });
    sourceDirs.push({ id: source.id, directory: source.captureDirectory });
    await prisma.captureSource.update({
      where: { id: source.id },
      data: { illuminationPolicy: "only-while-on", illuminationOutletId: outlet.id },
    });

    const captureSourcePhoto: CaptureSourceFn = async () => {
      throw new Error("illumination-off must not execute capture");
    };
    const runFanOut: FanOutFn = async (sourceCaptureId) => ({ sourceCaptureId, sourceWidth: 0, sourceHeight: 0, projectResults: [] });
    const scheduler = new CaptureSourceScheduler({ prisma, captureSourcePhoto, runViewportFanOut: runFanOut, now: () => now, logger: silentLogger() });
    await scheduler.tick();
    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 1);
    const tick = await scheduler.tick();

    expect(tick.captures[0]).toMatchObject({ status: "skipped", skipReason: "illumination-off" });
    await expect(prisma.captureSourceOccurrence.findUnique({
      where: { captureSourceId_scheduledFor: { captureSourceId: source.id, scheduledFor: target } },
    })).resolves.toMatchObject({ status: "skipped-illumination-off", skipReason: "illumination-off" });

    await prisma.nodeOutlet.update({ where: { id: outlet.id }, data: { actualState: null } });
    now = new Date(nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now }).getTime() + 1);
    const unknown = await scheduler.tick();
    expect(unknown.captures[0]).toMatchObject({ status: "skipped", skipReason: "illumination-state-unknown" });
  });

  it("unrestricted sources capture while the assigned outlet is OFF", async () => {
    let now = new Date("2026-07-15T12:00:00.000Z");
    const startAt = new Date("2026-07-15T11:59:00.000Z");
    const node = await createNode();
    nodeNames.push(node.name);
    const outlet = await createOutlet(node.id, { actualState: false });
    const source = await createTestCaptureSource(prisma, { captureStartAt: startAt, photoIntervalMinutes: 1 });
    sourceDirs.push({ id: source.id, directory: source.captureDirectory });
    await prisma.captureSource.update({
      where: { id: source.id },
      data: { illuminationPolicy: "unrestricted", illuminationOutletId: outlet.id },
    });

    const capturedIds: string[] = [];
    const captureSourcePhoto: CaptureSourceFn = async (captureSourceId, options) => {
      capturedIds.push(captureSourceId);
      const sourceCapture = await prisma.sourceCapture.create({
        data: {
          captureSourceId,
          timestamp: now,
          scheduledFor: options?.scheduledFor ?? null,
          originalPath: `/tmp/${captureSourceId}-${randomUUID()}.jpg`,
          originalWidth: 100,
          originalHeight: 100,
          workingWidth: 100,
          workingHeight: 100,
          pixelFormat: "mjpeg",
        },
      });
      return { sourceCapture, savedPath: sourceCapture.originalPath, alreadyExisted: false };
    };
    const runFanOut: FanOutFn = async (sourceCaptureId) => ({ sourceCaptureId, sourceWidth: 100, sourceHeight: 100, projectResults: [] });
    const scheduler = new CaptureSourceScheduler({ prisma, captureSourcePhoto, runViewportFanOut: runFanOut, now: () => now, logger: silentLogger() });
    await scheduler.tick();
    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 1);
    await scheduler.tick();

    expect(capturedIds).toEqual([source.id]);
  });

  it("fans out one shared SourceCapture according to project sampling intervals without duplicate physical captures", async () => {
    const anchor = new Date("2026-07-15T12:00:00.000Z");
    const source = await createTestCaptureSource(prisma, { photoIntervalMinutes: 15, captureStartAt: anchor, width: 80, height: 60 });
    sourceDirs.push({ id: source.id, directory: source.captureDirectory });
    const projects = await Promise.all([
      createTestProject(prisma, { cameraDevice: null, photoIntervalMinutes: 15 }),
      createTestProject(prisma, { cameraDevice: null, photoIntervalMinutes: 30 }),
      createTestProject(prisma, { cameraDevice: null, photoIntervalMinutes: 60 }),
    ]);
    for (const project of projects) {
      projectDirs.push({ id: project.id, directory: project.localPhotoDirectory });
    }
    await bindProjectToSource(projects[0].id, source.id, { interval: 15, anchor });
    await bindProjectToSource(projects[1].id, source.id, { interval: 30, anchor });
    await bindProjectToSource(projects[2].id, source.id, { interval: 60, anchor });

    const created = await createRealSourceCapture(prisma, source.id, {
      timestamp: new Date("2026-07-15T13:00:00.000Z"),
      scheduledFor: new Date("2026-07-15T13:00:00.000Z"),
      rawWidth: 80,
      rawHeight: 60,
    });
    extraDirs.push(created.directory);

    const first = await runViewportFanOut(created.sourceCapture.id);
    const second = await runViewportFanOut(created.sourceCapture.id);

    expect(first.projectResults.filter((result) => result.status === "success")).toHaveLength(3);
    expect(second.projectResults).toHaveLength(0);
    expect(await prisma.sourceCapture.count({ where: { captureSourceId: source.id } })).toBe(1);
    expect(await prisma.projectSourceSample.count({ where: { captureSourceId: source.id, sourceCaptureId: created.sourceCapture.id, status: "linked" } })).toBe(3);
    expect(await prisma.photo.count({ where: { sourceCaptureId: created.sourceCapture.id } })).toBe(3);
  });

  it("manual remote capture while light is OFF queues a job with warning metadata and does not toggle power", async () => {
    const attached = await createRemoteSource("greenhouse-node");
    nodeNames.push(attached.node.name);
    sourceDirs.push({ id: attached.captureSource.id, directory: attached.captureSource.captureDirectory });
    const outlet = await createOutlet(attached.node.id, { actualState: false });
    await prisma.captureSource.update({
      where: { id: attached.captureSource.id },
      data: { illuminationPolicy: "only-while-on", illuminationOutletId: outlet.id },
    });
    const project = await createTestProject(prisma, { cameraDevice: null, captureEnabled: false, photoIntervalMinutes: 30 });
    projectDirs.push({ id: project.id, directory: project.localPhotoDirectory });
    await bindProjectToSource(project.id, attached.captureSource.id, { interval: 30, anchor: new Date("2026-07-15T12:00:00.000Z") });

    const result = await captureProjectManually(prisma, project.id);

    expect(result).toMatchObject({
      mode: "remote-job",
      status: "queued",
      captureSourceId: attached.captureSource.id,
      illuminationState: false,
      illuminationWarning: true,
    });
    await expect(prisma.powerCommand.count({ where: { outletId: outlet.id } })).resolves.toBe(0);
    const job = await prisma.agentCaptureJob.findFirstOrThrow({ where: { captureSourceId: attached.captureSource.id, manualProjectId: project.id } });
    expect(job.scheduledFor).toBeNull();
  });

  it("returns source cadence, project sampling, illumination, and recent occurrence in the camera summary", async () => {
    const attached = await createRemoteSource("greenhouse-node");
    nodeNames.push(attached.node.name);
    sourceDirs.push({ id: attached.captureSource.id, directory: attached.captureSource.captureDirectory });
    const outlet = await createOutlet(attached.node.id, { actualState: false });
    await prisma.captureSource.update({
      where: { id: attached.captureSource.id },
      data: {
        photoIntervalMinutes: 15,
        timeZone: "America/New_York",
        captureWindowEnabled: true,
        captureWindowStartMinutes: 8 * 60,
        captureWindowEndMinutes: 0,
        illuminationPolicy: "only-while-on",
        illuminationOutletId: outlet.id,
      },
    });
    const project = await createTestProject(prisma, { cameraDevice: null, captureEnabled: true, photoIntervalMinutes: 30 });
    projectDirs.push({ id: project.id, directory: project.localPhotoDirectory });
    const anchor = new Date("2026-07-15T12:00:00.000Z");
    await bindProjectToSource(project.id, attached.captureSource.id, { interval: 30, anchor });
    await prisma.captureSourceOccurrence.create({
      data: {
        captureSourceId: attached.captureSource.id,
        scheduledFor: new Date("2026-07-15T12:15:00.000Z"),
        status: "skipped-illumination-off",
        skipReason: "illumination-off",
      },
    });

    const summary = await getProjectCameraSummary(prisma, project.id, new Date("2026-07-15T12:01:00.000Z"));

    expect(summary).toMatchObject({
      mode: "capture-source",
      source: {
        id: attached.captureSource.id,
        cadence: {
          intervalMinutes: 15,
          timeZone: "America/New_York",
          dailyWindow: { enabled: true, start: "08:00", end: "00:00", crossesMidnight: true },
        },
        illumination: {
          policy: "only-while-on",
          outletId: outlet.id,
          outletKey: outlet.key,
          observedState: false,
        },
      },
      projectSampling: {
        enabled: true,
        intervalMinutes: 30,
      },
      recentOccurrence: {
        status: "skipped-illumination-off",
        skipReason: "illumination-off",
        scheduledFor: "2026-07-15T12:15:00.000Z",
      },
    });
  });
});
