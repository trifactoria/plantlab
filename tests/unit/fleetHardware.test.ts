import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getFleetCameras } from "../../src/app/api/hardware/cameras/route";
import { GET as getFleetSensors } from "../../src/app/api/hardware/sensors/route";
import { updateCameraInventory, recordHeartbeat } from "../../src/lib/operations/agentProtocol";
import { configureFleetCamera, listFleetCameras, listFleetSensors, testFleetCameraCapture } from "../../src/lib/operations/fleetHardware";
import { attachNodeCamera } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../../src/lib/operations/environmentProtocol";
import { createDesiredSensorConfigRevision, reportAppliedSensorConfig } from "../../src/lib/operations/sensorConfig";
import { prisma } from "../../src/lib/prisma";

const FORMATS = [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }, { width: 1280, height: 720, frameRates: ["30 fps"] }] }];

afterEach(() => {
  vi.unstubAllEnvs();
});

async function onlineNode(name: string, role: "coordinator" | "camera-node" | "standalone" | "greenhouse-node") {
  const registered = await registerOrRotateNode(prisma, { name, role, rotateCredential: true, capabilities: ["camera", "temperature", "humidity"] });
  await recordHeartbeat(prisma, registered.node.id, { hostname: name, role, capabilities: ["camera", "temperature", "humidity"] });
  return registered;
}

async function cameraOnNode(nodeName: string, stableId: string) {
  const registered = await onlineNode(nodeName, nodeName === "plantlab" ? "coordinator" : nodeName === "xps" ? "standalone" : "greenhouse-node");
  await updateCameraInventory(prisma, registered.node.id, [
    { stableId, devicePath: "/dev/video0", name: `${nodeName} reported camera`, formats: FORMATS, available: true },
  ]);
  const [camera] = await prisma.nodeCamera.findMany({ where: { nodeId: registered.node.id } });
  return { registered, camera };
}

describe("fleet hardware contracts", () => {
  it("includes coordinator-local, standalone-local, and attached-node cameras without depending on execution routing", async () => {
    const coordinator = await cameraOnNode("plantlab", "coordinator-camera");
    const standalone = await cameraOnNode("xps", "standalone-camera");
    const remote = await cameraOnNode("greenhouse-zero", "remote-camera");
    await configureFleetCamera(prisma, { cameraId: coordinator.camera.id, displayName: "Coordinator Wide" });
    await configureFleetCamera(prisma, { cameraId: standalone.camera.id, displayName: "Standalone Wide" });
    await configureFleetCamera(prisma, { cameraId: remote.camera.id, displayName: "Remote Wide" });

    const cameras = await listFleetCameras(prisma, { includeLocalDiscovery: false });
    expect(cameras.map((camera) => camera.displayName)).toEqual(expect.arrayContaining(["Coordinator Wide", "Standalone Wide", "Remote Wide"]));
    expect(cameras.map((camera) => camera.node.name)).toEqual(expect.arrayContaining(["plantlab", "xps", "greenhouse-zero"]));
    expect(cameras.every((camera) => !camera.displayName.startsWith("/dev/video"))).toBe(true);
  });

  it("normalizes retired and unavailable camera states", async () => {
    const { camera } = await cameraOnNode("fleet-retired-node", "retired-camera");
    await prisma.nodeCamera.update({ where: { id: camera.id }, data: { retiredAt: new Date(), enabled: false } });
    const summary = (await listFleetCameras(prisma, { includeLocalDiscovery: false })).find((item) => item.id === camera.id)!;
    expect(summary.status).toBe("retired");
    expect(summary.usableForCapture).toBe(false);
  });

  it("keeps configured mode primary after a fallback capture", async () => {
    const { camera } = await cameraOnNode("fleet-fallback-node", "fallback-camera");
    const attached = await attachNodeCamera(prisma, { nodeName: "fleet-fallback-node", stableId: camera.stableId, newCaptureSourceName: "Fallback Source", width: 1920, height: 1080, inputFormat: "mjpeg" });
    await prisma.agentCaptureJob.create({
      data: {
        nodeId: attached.node.id,
        assignmentId: attached.assignment.id,
        captureSourceId: attached.captureSource.id,
        status: "completed",
        completedAt: new Date(),
        effectiveWidth: 640,
        effectiveHeight: 480,
        effectiveInputFormat: "mjpeg",
        fallbackUsed: true,
      },
    });
    const summary = (await listFleetCameras(prisma, { includeLocalDiscovery: false })).find((item) => item.id === camera.id)!;
    expect(summary.currentMode).toMatchObject({ width: 1920, height: 1080, inputFormat: "mjpeg" });
    expect(summary.lastCaptureFallbackUsed).toBe(true);
  });

  it("exposes local discovery cameras through the fleet API when configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "1");
    const response = await getFleetCameras();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cameras.some((camera: { displayName: string; node: { localToCoordinator: boolean } }) => camera.displayName === "Mock USB Camera" && camera.node.localToCoordinator)).toBe(true);
  });

  it("keeps remote fleet management available when local discovery is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    await cameraOnNode("remote-no-local", "remote-no-local-camera");
    const response = await getFleetCameras();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.cameras.some((camera: { node: { name: string } }) => camera.node.name === "remote-no-local")).toBe(true);
  });

  it("queues remote test captures without accepting a raw device path", async () => {
    const { camera } = await cameraOnNode("fleet-test-node", "test-camera");
    const attached = await attachNodeCamera(prisma, { nodeName: "fleet-test-node", stableId: camera.stableId, newCaptureSourceName: "Test Source", width: 1280, height: 720, inputFormat: "mjpeg" });
    const result = await testFleetCameraCapture(prisma, { cameraId: camera.id });
    expect(result).toMatchObject({ mode: "remote-node", status: "queued", requestedMode: { width: 1280, height: 720 } });
    const job = await prisma.agentCaptureJob.findUniqueOrThrow({ where: { id: result.jobId as string } });
    expect(job.assignmentId).toBe(attached.assignment.id);
  });

  it("includes desired/applied state and canonical health in the fleet sensor API", async () => {
    const registered = await onlineNode("fleet-sensor-node", "greenhouse-node");
    const entries = [{ key: "middle", name: "Middle shelf", type: "dht22", gpio: 17, placement: "middle", enabled: true }];
    const desired = await createDesiredSensorConfigRevision(prisma, "fleet-sensor-node", entries);
    await reportAppliedSensorConfig(prisma, registered.node.id, { revision: desired.revision, status: "applied", entries });
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            {
              eventId: "fleet-sensor-accepted",
              sensor: { key: "middle", name: "Reported middle", type: "dht22", gpio: 4, placement: "reported", enabled: false },
              capturedAt: "2026-07-15T12:00:00.000Z",
              classification: "accepted",
              temperatureC: 22,
              humidityPct: 50,
            },
          ],
        },
        new Date("2026-07-15T12:01:00.000Z"),
      ),
    );
    const sensors = await listFleetSensors(prisma, { now: new Date("2026-07-15T12:01:00.000Z") });
    const sensor = sensors.find((item) => item.key === "middle")!;
    expect(sensor).toMatchObject({
      displayName: "Middle shelf",
      reportedName: "Reported middle",
      gpio: 17,
      placement: "middle",
      configState: "applied",
      health: { state: "healthy" },
    });
  });

  it("exposes fleet sensors through the route", async () => {
    const registered = await onlineNode("fleet-sensor-route-node", "greenhouse-node");
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch(
        {
          events: [
            {
              eventId: "fleet-sensor-route",
              sensor: { key: "top", name: "Top", type: "dht22", gpio: 4, placement: "top", enabled: true },
              capturedAt: new Date().toISOString(),
              classification: "accepted",
              temperatureC: 21,
              humidityPct: 52,
            },
          ],
        },
        new Date(),
      ),
    );
    const response = await getFleetSensors();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sensors.some((sensor: { key: string; health: { state: string } }) => sensor.key === "top" && sensor.health.state === "healthy")).toBe(true);
  });
});
