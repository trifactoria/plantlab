import { afterEach, describe, expect, it } from "vitest";
import { GET as getAvailableSources } from "../../src/app/api/capture-sources/available/route";
import { POST as createProjectRoute } from "../../src/app/api/projects/route";
import { GET as getProjectMetrics } from "../../src/app/api/projects/[projectId]/metrics/history/route";
import { GET as getPhotoEnvironment } from "../../src/app/api/projects/[projectId]/photos/[photoId]/environment/route";
import { POST as linkProjectSensorRoute } from "../../src/app/api/projects/[projectId]/sensors/route";
import { CaptureSourceScheduler, type CaptureSourceFn, type FanOutFn } from "../../src/lib/captureSourceService";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { attachNodeCamera } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { projectCaptureSummary } from "../../src/lib/operations/projectCapture";
import { prisma } from "../../src/lib/prisma";
import { nextAlignedCaptureTime } from "../../src/lib/schedule";
import { cleanupTestProject, createFakePhoto, createTestProject } from "./helpers/testProject";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function silentLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

async function createRemoteSource(nodeName = `vitest-node-${crypto.randomUUID()}`) {
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
  return attached;
}

describe("distributed project capture and environmental bindings", () => {
  const projectIds: string[] = [];
  const projectDirs: Array<{ id: string; directory: string }> = [];
  const nodeNames: string[] = [];
  const captureSourceIds: string[] = [];

  afterEach(async () => {
    for (const { id, directory } of projectDirs.splice(0)) {
      await cleanupTestProject(prisma, id, directory);
    }
    for (const id of projectIds.splice(0)) {
      await prisma.project.deleteMany({ where: { id } });
    }
    for (const id of captureSourceIds.splice(0)) {
      await prisma.captureSource.deleteMany({ where: { id } });
    }
    for (const name of nodeNames.splice(0)) {
      await prisma.plantLabNode.deleteMany({ where: { name } });
    }
  });

  it("returns configured remote capture sources without duplicating historical endpoints", async () => {
    const nodeName = `vitest-available-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const attached = await createRemoteSource(nodeName);
    captureSourceIds.push(attached.captureSource.id);
    await updateCameraInventory(prisma, attached.node.id, [
      {
        stableId: attached.camera.stableId,
        devicePath: "/dev/video2",
        name: "Remote Camera",
        vendorId: attached.camera.vendorId,
        productId: attached.camera.productId,
        serial: attached.camera.serial,
        physicalPath: attached.camera.physicalPath,
        formats: [{ pixelFormat: "mjpeg", description: "MJPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
    ]);

    const response = await getAvailableSources(new Request("http://localhost/api/capture-sources/available"));
    const body = await response.json();
    const matching = body.sources.filter((source: { id: string }) => source.id === attached.captureSource.id);

    expect(response.status).toBe(200);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      mode: "remote-node",
      node: { name: nodeName },
      available: true,
      retired: false,
      assignmentActive: true,
      currentEndpointAvailable: true,
      supportsScheduledCapture: true,
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
    });
  });

  it("creates a project bound to a remote captureSourceId and preserves direct-local compatibility", async () => {
    const nodeName = `vitest-project-source-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const attached = await createRemoteSource(nodeName);
    captureSourceIds.push(attached.captureSource.id);

    const response = await createProjectRoute(
      jsonRequest("http://localhost/api/projects", {
        name: "Remote source project",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 15,
        captureStartAt: "2026-07-14T12:00:00.000Z",
        captureEnabled: true,
        captureSourceId: attached.captureSource.id,
      }),
    );
    const body = await response.json();
    projectIds.push(body.id);

    expect(response.status).toBe(201);
    expect(body.cameraDevice).toBeNull();
    expect(body.capture).toMatchObject({ mode: "capture-source", captureSourceId: attached.captureSource.id, degraded: false });
    expect(await prisma.projectViewport.count({ where: { projectId: body.id, captureSourceId: attached.captureSource.id, active: true } })).toBe(1);

    const direct = await createTestProject(prisma, { captureEnabled: true, cameraDevice: "/dev/video-vitest-direct" });
    projectDirs.push({ id: direct.id, directory: direct.localPhotoDirectory });
    await expect(projectCaptureSummary(prisma, direct.id)).resolves.toMatchObject({ mode: "direct-local", cameraDevice: "/dev/video-vitest-direct" });
  });

  it("rejects nonexistent or unavailable capture sources during project creation", async () => {
    const missing = await createProjectRoute(
      jsonRequest("http://localhost/api/projects", {
        name: "Missing source project",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 15,
        captureEnabled: true,
        captureSourceId: "does-not-exist",
      }),
    );
    expect(missing.status).toBe(400);

    const nodeName = `vitest-retired-source-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const attached = await createRemoteSource(nodeName);
    captureSourceIds.push(attached.captureSource.id);
    await prisma.nodeCamera.update({ where: { id: attached.camera.id }, data: { retiredAt: new Date(), enabled: false } });
    const retired = await createProjectRoute(
      jsonRequest("http://localhost/api/projects", {
        name: "Retired source project",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 15,
        captureEnabled: true,
        captureSourceId: attached.captureSource.id,
      }),
    );
    expect(retired.status).toBe(400);
  });

  it("queues one remote AgentCaptureJob per source slot instead of running local capture", async () => {
    let now = new Date("2026-07-14T12:00:00.000Z");
    const startAt = new Date("2026-07-14T11:59:00.000Z");
    const nodeName = `vitest-scheduled-source-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const attached = await createRemoteSource(nodeName);
    captureSourceIds.push(attached.captureSource.id);
    await prisma.captureSource.update({ where: { id: attached.captureSource.id }, data: { captureStartAt: startAt, photoIntervalMinutes: 1 } });

    const captureSourcePhoto: CaptureSourceFn = async () => {
      throw new Error("remote assigned source should not capture locally");
    };
    const runViewportFanOut: FanOutFn = async (sourceCaptureId) => ({ sourceCaptureId, sourceWidth: 0, sourceHeight: 0, projectResults: [] });
    const scheduler = new CaptureSourceScheduler({ prisma, captureSourcePhoto, runViewportFanOut, now: () => now, logger: silentLogger() });

    await scheduler.tick();
    const target = nextAlignedCaptureTime({ startAt, intervalMinutes: 1, now });
    now = new Date(target.getTime() + 1);
    const first = await scheduler.tick();

    expect(first.captures[0]).toMatchObject({ status: "queued", captureSourceId: attached.captureSource.id });
    expect(await prisma.agentCaptureJob.count({ where: { captureSourceId: attached.captureSource.id, scheduledFor: target } })).toBe(1);
  });

  it("links project sensors, returns linked accepted metric history, and bounds nearest photo environment", async () => {
    const nodeName = `vitest-project-sensors-${crypto.randomUUID()}`;
    nodeNames.push(nodeName);
    const registered = await registerOrRotateNode(prisma, { name: nodeName, role: "greenhouse-node", rotateCredential: true });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            {
              eventId: "project-sensor-good",
              sensor: { key: "greenhouse-outside", name: "Outside", type: "dht22", gpio: 4, placement: "outside", enabled: true },
              capturedAt: "2026-07-14T12:00:00.000Z",
              classification: "accepted",
              temperatureC: 21,
              humidityPct: 55,
            },
            {
              eventId: "project-sensor-rejected",
              sensor: { key: "greenhouse-outside", name: "Outside", type: "dht22", gpio: 4, placement: "outside", enabled: true },
              capturedAt: "2026-07-14T12:03:00.000Z",
              classification: "rejected",
              temperatureC: 22,
              humidityPct: 56,
              diagnosticCode: "plausibility",
            },
          ],
        },
        new Date("2026-07-14T12:04:00.000Z"),
      ),
    );
    const sensor = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId: registered.node.id, key: "greenhouse-outside" } } });
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null });
    projectDirs.push({ id: project.id, directory: project.localPhotoDirectory });

    const link = await linkProjectSensorRoute(jsonRequest(`http://localhost/api/projects/${project.id}/sensors`, { sensorId: sensor.id, role: "outside-reference" }), {
      params: Promise.resolve({ projectId: project.id }),
    });
    const binding = await link.json();
    expect(link.status).toBe(201);
    expect(binding.sensor.id).toBe(sensor.id);

    const metrics = await getProjectMetrics(
      new Request(`http://localhost/api/projects/${project.id}/metrics/history?metrics=temperatureC,humidityPct&from=2026-07-14T11:55:00.000Z&to=2026-07-14T12:10:00.000Z&resolution=raw`),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const metricsBody = await metrics.json();
    expect(metrics.status).toBe(200);
    expect(metricsBody.series.find((series: { metric: string }) => series.metric === "temperatureC").points).toEqual([
      { at: "2026-07-14T12:00:00.000Z", value: 21 },
    ]);

    const photo = await createFakePhoto(prisma, project.id);
    await prisma.photo.update({ where: { id: photo.id }, data: { timestamp: new Date("2026-07-14T12:05:00.000Z") } });
    const environment = await getPhotoEnvironment(
      new Request(`http://localhost/api/projects/${project.id}/photos/${photo.id}/environment?maxDistanceMs=600000`),
      { params: Promise.resolve({ projectId: project.id, photoId: photo.id }) },
    );
    const environmentBody = await environment.json();
    expect(environmentBody.readings[0].reading).toMatchObject({ temperatureC: 21, humidityPct: 55, distanceMs: 300000 });

    const tooFar = await getPhotoEnvironment(
      new Request(`http://localhost/api/projects/${project.id}/photos/${photo.id}/environment?maxDistanceMs=60000`),
      { params: Promise.resolve({ projectId: project.id, photoId: photo.id }) },
    );
    expect((await tooFar.json()).readings[0].reading).toBeNull();
  });
});
