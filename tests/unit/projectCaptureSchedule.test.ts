import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GET as getCaptureSummaryRoute } from "../../src/app/api/projects/[projectId]/capture-summary/route";
import { getEffectiveProjectCaptureSchedule, getProjectCaptureSummaryDetails } from "../../src/lib/operations/projectCaptureSchedule";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";
import { createTestCaptureSource } from "./helpers/testCaptureSource";
import { createTestProject } from "./helpers/testProject";

async function bindSourceProject(sourceId: string, overrides: Parameters<typeof createTestProject>[1] = {}) {
  const project = await createTestProject(prisma, {
    cameraDevice: null,
    captureEnabled: false,
    photoIntervalMinutes: 15,
    ...overrides,
  });
  await prisma.projectViewport.create({
    data: {
      projectId: project.id,
      captureSourceId: sourceId,
      cropX: 0,
      cropY: 0,
      cropWidth: 1,
      cropHeight: 1,
      effectiveFrom: new Date("2026-07-13T00:00:00.000Z"),
      active: true,
    },
  });
  return project;
}

async function assignedSource(options: { available?: boolean; retired?: boolean } = {}) {
  const registered = await registerOrRotateNode(prisma, { name: `schedule-node-${randomUUID()}`, role: "camera-node", rotateCredential: true });
  const source = await createTestCaptureSource(prisma, {
    name: "Schedule Source",
    photoIntervalMinutes: 45,
    captureStartAt: new Date("2026-07-13T00:00:00.000Z"),
  });
  const camera = await prisma.nodeCamera.create({
    data: {
      nodeId: registered.node.id,
      stableId: `usb:${randomUUID()}`,
      devicePath: "/dev/video0",
      available: options.available ?? true,
      retiredAt: options.retired ? new Date("2026-07-13T01:00:00.000Z") : null,
    },
  });
  await prisma.nodeCameraAssignment.create({
    data: {
      nodeId: registered.node.id,
      nodeCameraId: camera.id,
      captureSourceId: source.id,
      name: source.name,
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
      active: true,
    },
  });
  return { source, camera, node: registered.node };
}

describe("effective project capture schedule", () => {
  it("returns none when a project has no camera or CaptureSource", async () => {
    const project = await createTestProject(prisma, { cameraDevice: null, captureEnabled: false });
    const schedule = await getEffectiveProjectCaptureSchedule(prisma, project.id, new Date("2026-07-13T03:30:00.000Z"));
    expect(schedule).toMatchObject({ mode: "none", enabled: false, owner: null, intervalMinutes: null });
  });

  it("uses project-owned schedule fields for direct-local projects", async () => {
    const project = await createTestProject(prisma, {
      cameraDevice: "/dev/video4",
      captureEnabled: true,
      captureStartAt: new Date("2026-07-13T00:00:00.000Z"),
      photoIntervalMinutes: 60,
      timeZone: "America/New_York",
      captureWindowEnabled: true,
      captureWindowStartMinutes: 6 * 60,
      captureWindowEndMinutes: 22 * 60,
    });
    const schedule = await getEffectiveProjectCaptureSchedule(prisma, project.id, new Date("2026-07-13T00:30:00.000Z"));
    expect(schedule).toMatchObject({
      mode: "direct-local",
      enabled: true,
      owner: "project",
      intervalMinutes: 60,
      dailyWindow: { enabled: true, start: "06:00", end: "22:00" },
      legacyProjectSchedulePresent: false,
      conflict: { exists: false },
    });
    expect(schedule?.nextCaptureAt).toBe("2026-07-13T01:00:00.000Z");
  });

  it("returns direct-local disabled schedule without a next capture", async () => {
    const project = await createTestProject(prisma, { cameraDevice: "/dev/video4", captureEnabled: false });
    const schedule = await getEffectiveProjectCaptureSchedule(prisma, project.id);
    expect(schedule).toMatchObject({ mode: "direct-local", enabled: false, owner: "project", nextCaptureAt: null });
  });

  it("uses CaptureSource schedule and reports stale project interval separately", async () => {
    const { source, node } = await assignedSource();
    const project = await bindSourceProject(source.id, {
      captureEnabled: true,
      photoIntervalMinutes: 5,
      captureStartAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    const schedule = await getEffectiveProjectCaptureSchedule(prisma, project.id, new Date("2026-07-13T00:10:00.000Z"));
    expect(schedule).toMatchObject({
      mode: "capture-source",
      enabled: true,
      owner: "capture-source",
      intervalMinutes: 45,
      captureSource: { id: source.id, name: source.name, nodeName: node.name },
      legacyProjectSchedulePresent: true,
    });
    expect(schedule?.nextCaptureAt).toBe("2026-07-13T00:45:00.000Z");
  });

  it("reports unavailable, retired, and inactive CaptureSource states for summaries", async () => {
    const unavailable = await assignedSource({ available: false });
    const unavailableProject = await bindSourceProject(unavailable.source.id);
    const unavailableSummary = await getProjectCaptureSummaryDetails(prisma, unavailableProject.id);
    expect(unavailableSummary?.degraded).toBe(true);
    expect(unavailableSummary?.selectedCamera).toMatchObject({ mode: "capture-source", available: false });

    const retired = await assignedSource({ retired: true });
    const retiredProject = await bindSourceProject(retired.source.id);
    const retiredSchedule = await getEffectiveProjectCaptureSchedule(prisma, retiredProject.id);
    expect(retiredSchedule?.conflict).toMatchObject({ exists: true, reason: "Selected CaptureSource camera is retired." });

    const inactiveSource = await createTestCaptureSource(prisma, { active: false, photoIntervalMinutes: 30 });
    const inactiveProject = await bindSourceProject(inactiveSource.id);
    const inactiveSchedule = await getEffectiveProjectCaptureSchedule(prisma, inactiveProject.id);
    expect(inactiveSchedule).toMatchObject({ mode: "capture-source", enabled: false, nextCaptureAt: null, conflict: { exists: true } });
  });

  it("exposes the capture summary route", async () => {
    const source = await createTestCaptureSource(prisma, { photoIntervalMinutes: 30 });
    const project = await bindSourceProject(source.id);
    const response = await getCaptureSummaryRoute(new Request("http://localhost"), { params: Promise.resolve({ projectId: project.id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.effectiveSchedule).toMatchObject({ mode: "capture-source", owner: "capture-source", intervalMinutes: 30 });
  });
});
