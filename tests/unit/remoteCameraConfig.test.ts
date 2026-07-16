import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getFleetCamera } from "../../src/app/api/hardware/cameras/[cameraId]/route";
import { GET as getSourceFormats } from "../../src/app/api/capture-sources/[sourceId]/formats/route";
import { PATCH as patchCameraConfig } from "../../src/app/api/hardware/cameras/[cameraId]/configuration/route";
import { recordHeartbeat, updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { configureFleetCamera, getFleetCamera as getFleetCameraOp } from "../../src/lib/operations/fleetHardware";
import { attachNodeCamera } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

const FORMATS = [
  {
    pixelFormat: "mjpeg",
    description: "Motion-JPEG",
    resolutions: [
      { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
      { width: 1280, height: 720, frameRates: ["30.000 fps"] },
      { width: 640, height: 480, frameRates: ["30.000 fps"] },
    ],
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

async function remoteCameraWithSource(nodeName: string) {
  const registered = await registerOrRotateNode(prisma, { name: nodeName, role: "greenhouse-node", rotateCredential: true, capabilities: ["camera"] });
  await recordHeartbeat(prisma, registered.node.id, { hostname: nodeName, role: "greenhouse-node", capabilities: ["camera"] });
  await updateCameraInventory(prisma, registered.node.id, [
    { stableId: `usb:${nodeName}`, devicePath: "/dev/video0", name: "webcam 1080P: webcam 1080P (1.2)", formats: FORMATS, available: true },
  ]);
  const [camera] = await prisma.nodeCamera.findMany({ where: { nodeId: registered.node.id } });
  const attached = await attachNodeCamera(prisma, { nodeName, stableId: camera.stableId, newCaptureSourceName: `${nodeName} source`, width: 1280, height: 720, inputFormat: "mjpeg" });
  return { registered, camera, attached };
}

describe("remote camera configuration (Priority 0)", () => {
  it("single fleet camera GET returns the user displayName as identity and reportedName as secondary, with real supported modes", async () => {
    const { camera } = await remoteCameraWithSource(`p0-name-${crypto.randomUUID()}`);
    await configureFleetCamera(prisma, { cameraId: camera.id, displayName: "Greenhouse Top Shelf" });

    const response = await getFleetCamera(new Request("http://localhost"), { params: Promise.resolve({ cameraId: camera.id }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.camera.displayName).toBe("Greenhouse Top Shelf");
    expect(body.camera.reportedName).toBe("webcam 1080P: webcam 1080P (1.2)");
    // Real reported modes populate the selector data, including 1080p.
    expect(body.camera.supportedModes).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 1920, height: 1080, inputFormat: "mjpeg" })]),
    );
  });

  it("saving 1920x1080 persists 1080p and never downgrades to 720p", async () => {
    const { camera } = await remoteCameraWithSource(`p0-1080-${crypto.randomUUID()}`);
    const response = await patchCameraConfig(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ resolution: { width: 1920, height: 1080 }, inputFormat: "mjpeg", frameRate: "30" }) }),
      { params: Promise.resolve({ cameraId: camera.id }) },
    );
    expect(response.status).toBe(200);
    const reloaded = await getFleetCameraOp(prisma, camera.id);
    expect(reloaded?.currentMode).toMatchObject({ width: 1920, height: 1080, inputFormat: "mjpeg" });
  });

  it("an inventory refresh does not overwrite the user-set display name", async () => {
    const { registered, camera } = await remoteCameraWithSource(`p0-refresh-${crypto.randomUUID()}`);
    await configureFleetCamera(prisma, { cameraId: camera.id, displayName: "Greenhouse Door" });
    // Node re-reports inventory (its hardware name) after the rename.
    await updateCameraInventory(prisma, registered.node.id, [
      { stableId: camera.stableId, devicePath: "/dev/video0", name: "webcam 1080P: webcam 1080P (1.3.3)", formats: FORMATS, available: true },
    ]);
    const reloaded = await getFleetCameraOp(prisma, camera.id);
    expect(reloaded?.displayName).toBe("Greenhouse Door");
    expect(reloaded?.reportedName).toBe("webcam 1080P: webcam 1080P (1.3.3)");
  });

  it("saving only the display name preserves the source schedule fields", async () => {
    const { camera, attached } = await remoteCameraWithSource(`p0-sched-${crypto.randomUUID()}`);
    await prisma.captureSource.update({
      where: { id: attached.captureSource.id },
      data: { photoIntervalMinutes: 15, timeZone: "America/New_York", captureWindowEnabled: true, captureWindowStartMinutes: 480, captureWindowEndMinutes: 0 },
    });
    await patchCameraConfig(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ displayName: "Greenhouse Wide" }) }),
      { params: Promise.resolve({ cameraId: camera.id }) },
    );
    const source = await prisma.captureSource.findUniqueOrThrow({ where: { id: attached.captureSource.id } });
    expect(source.photoIntervalMinutes).toBe(15);
    expect(source.captureWindowEnabled).toBe(true);
    expect(source.captureWindowStartMinutes).toBe(480);
    expect(source.captureWindowEndMinutes).toBe(0);
  });

  it("the shelf-camera formats route serves remote supported modes in production (not blocked by the local-hardware guard)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    const { attached } = await remoteCameraWithSource(`p0-formats-${crypto.randomUUID()}`);
    const response = await getSourceFormats(new Request("http://localhost"), { params: Promise.resolve({ sourceId: attached.captureSource.id }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.formats.length).toBeGreaterThan(0);
    expect(body.formats[0].resolutions).toEqual(expect.arrayContaining([expect.objectContaining({ width: 1920, height: 1080 })]));
  });

  it("configuration does not require local camera hardware for a remote camera in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    const { camera } = await remoteCameraWithSource(`p0-prod-${crypto.randomUUID()}`);
    const response = await patchCameraConfig(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ displayName: "Configured In Production" }) }),
      { params: Promise.resolve({ cameraId: camera.id }) },
    );
    expect(response.status).toBe(200);
    const reloaded = await getFleetCameraOp(prisma, camera.id);
    expect(reloaded?.displayName).toBe("Configured In Production");
  });
});
