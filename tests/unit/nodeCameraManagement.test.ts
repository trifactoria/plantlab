import { beforeEach, describe, expect, it } from "vitest";
import { updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import {
  attachNodeCamera,
  listCameraReattachCandidates,
  listNodeCameras,
  queueCameraTestCapture,
  reattachNodeCamera,
  renameNodeCamera,
  restoreNodeCamera,
  retireNodeCamera,
  setNodeCameraEnabled,
  updateCameraAssignmentConfig,
} from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

const NODE = "camera-mgmt-node";
const SHARED = { vendorId: "32e6", productId: "9221", serial: "SHAREDSERIAL" };
const FORMATS = [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }, { width: 1280, height: 720, frameRates: ["30 fps"] }] }];

async function nodeId() {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: NODE } });
  return node.id;
}

async function seed() {
  const registered = await registerOrRotateNode(prisma, { name: NODE, role: "greenhouse-node", rotateCredential: true });
  // Two physically-identical cameras (same serial) at different USB paths.
  await updateCameraInventory(prisma, registered.node.id, [
    { stableId: "usb:32e6:9221:SHAREDSERIAL:path:usb-0:1.1", devicePath: "/dev/video0", name: "webcam 1080P", ...SHARED, physicalPath: "platform-usb-0:1.1", usbPath: "platform-usb-0:1.1", usbPort: "1.1", formats: FORMATS, available: true },
    { stableId: "usb:32e6:9221:SHAREDSERIAL:path:usb-0:1.2", devicePath: "/dev/video2", name: "webcam 1080P", ...SHARED, physicalPath: "platform-usb-0:1.2", usbPath: "platform-usb-0:1.2", usbPort: "1.2", formats: FORMATS, available: true },
  ]);
  return registered.node.id;
}

async function firstCamera() {
  const [node] = await listNodeCameras(prisma, NODE);
  return node.cameras[0];
}

describe("camera management operations", () => {
  beforeEach(async () => {
    await prisma.plantLabNode.deleteMany({ where: { name: NODE } });
    await seed();
  });

  it("distinguishes physically-identical cameras (same serial) by USB / physical path", async () => {
    const [node] = await listNodeCameras(prisma, NODE);
    const serials = new Set(node.cameras.map((camera) => camera.serial));
    const paths = new Set(node.cameras.map((camera) => camera.physicalPath));
    expect(serials.size).toBe(1); // identical serials
    expect(paths.size).toBe(node.cameras.length); // distinct physical paths
  });

  it("renames a camera without changing its logical id", async () => {
    const camera = await firstCamera();
    const updated = await renameNodeCamera(prisma, { nodeName: NODE, cameraId: camera.id, name: "Greenhouse Wide" });
    expect(updated.id).toBe(camera.id);
    expect(updated.name).toBe("Greenhouse Wide");
    expect(updated.stableId).toBe(camera.stableId);
  });

  it("disables and re-enables a camera", async () => {
    const camera = await firstCamera();
    const disabled = await setNodeCameraEnabled(prisma, { nodeName: NODE, cameraId: camera.id, enabled: false });
    expect(disabled.enabled).toBe(false);
    const enabled = await setNodeCameraEnabled(prisma, { nodeName: NODE, cameraId: camera.id, enabled: true });
    expect(enabled.enabled).toBe(true);
  });

  it("retires and restores a camera, preserving it (never deleting)", async () => {
    const camera = await firstCamera();
    const retired = await retireNodeCamera(prisma, { nodeName: NODE, cameraId: camera.id });
    expect(retired.retiredAt).not.toBeNull();
    expect(retired.enabled).toBe(false);
    // Still present in the database (history preserved).
    expect(await prisma.nodeCamera.findUnique({ where: { id: camera.id } })).not.toBeNull();
    const restored = await restoreNodeCamera(prisma, { nodeName: NODE, cameraId: camera.id });
    expect(restored.retiredAt).toBeNull();
    expect(restored.enabled).toBe(true);
  });

  it("edits an assignment's config without changing the logical camera", async () => {
    const camera = await firstCamera();
    const attached = await attachNodeCamera(prisma, { nodeName: NODE, stableId: camera.stableId, newCaptureSourceName: "Wide source", width: 1280, height: 720, inputFormat: "mjpeg" });
    const updated = await updateCameraAssignmentConfig(prisma, { nodeName: NODE, assignmentId: attached.assignment.id, width: 1920, height: 1080, name: "Wide 1080p" });
    expect(updated.nodeCameraId).toBe(camera.id);
    expect(updated.width).toBe(1920);
    expect(updated.name).toBe("Wide 1080p");
  });

  it("queues a test capture as an AgentCaptureJob for the assignment", async () => {
    const camera = await firstCamera();
    const attached = await attachNodeCamera(prisma, { nodeName: NODE, stableId: camera.stableId, newCaptureSourceName: "Wide source", width: 1920, height: 1080, inputFormat: "mjpeg" });
    const { jobId, reused } = await queueCameraTestCapture(prisma, { nodeName: NODE, assignmentId: attached.assignment.id });
    expect(reused).toBe(false);
    const job = await prisma.agentCaptureJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.assignmentId).toBe(attached.assignment.id);
    expect(job.status).toBe("queued");
    // A second request reuses the still-pending job rather than piling up.
    const second = await queueCameraTestCapture(prisma, { nodeName: NODE, assignmentId: attached.assignment.id });
    expect(second.reused).toBe(true);
  });

  describe("reattach", () => {
    async function makeUnavailableWithCandidate() {
      const id = await nodeId();
      // Camera at 1.3 goes unavailable after a reconnect; a matching available
      // endpoint appears at 1.3.3 (serial + vendor/product match).
      const camera = await prisma.nodeCamera.create({
        data: { nodeId: id, stableId: "usb:32e6:9221:SHAREDSERIAL:path:usb-0:1.3", devicePath: "/dev/video4", name: "webcam 1080P", ...SHARED, physicalPath: "platform-usb-0:1.3", usbPort: "1.3", available: false, enabled: true, formatsJson: JSON.stringify(FORMATS) },
      });
      const endpoint = await prisma.nodeCameraEndpoint.create({
        data: { nodeId: id, nodeCameraId: null, stableId: "usb:32e6:9221:SHAREDSERIAL:path:usb-0:1.3.3", devicePath: "/dev/video6", name: "webcam 1080P", ...SHARED, physicalPath: "platform-usb-0:1.3.3", usbPort: "1.3.3", available: true, formatsJson: JSON.stringify(FORMATS), evidenceJson: JSON.stringify({ serial: SHARED.serial }) },
      });
      return { camera, endpoint };
    }

    it("lists available endpoints as candidates with confidence and match reasons", async () => {
      const { camera } = await makeUnavailableWithCandidate();
      const candidates = await listCameraReattachCandidates(prisma, { nodeName: NODE, cameraId: camera.id });
      expect(candidates.length).toBeGreaterThan(0);
      const serialMatch = candidates.find((candidate) => candidate.reasons.includes("vendor-product-serial-match"));
      expect(serialMatch).toBeDefined();
      // Identical-serial devices must not be presented as a certain (high) match on serial alone.
      expect(serialMatch?.confidence).not.toBe("high");
    });

    it("reattaches to a selected endpoint and adopts its device path and stable id", async () => {
      const { camera, endpoint } = await makeUnavailableWithCandidate();
      const result = await reattachNodeCamera(prisma, { nodeName: NODE, cameraId: camera.id, endpointId: endpoint.id });
      expect(result.camera.id).toBe(camera.id); // same logical camera
      expect(result.camera.devicePath).toBe("/dev/video6");
      expect(result.camera.stableId).toBe(endpoint.stableId);
      expect(result.camera.available).toBe(true);
      expect(result.camera.retiredAt).toBeNull();
    });

    it("refuses to steal an endpoint that is assigned to another active camera, leaving the current assignment unchanged", async () => {
      const id = await nodeId();
      const camera = await firstCamera();
      // Give the other active camera an active assignment tied to its endpoint.
      const other = (await listNodeCameras(prisma, NODE))[0].cameras.find((c) => c.id !== camera.id)!;
      const attached = await attachNodeCamera(prisma, { nodeName: NODE, stableId: other.stableId, newCaptureSourceName: "Other source", width: 1920, height: 1080, inputFormat: "mjpeg" });
      const otherEndpoint = await prisma.nodeCameraEndpoint.findFirstOrThrow({ where: { nodeId: id, nodeCameraId: other.id, available: true } });

      // A different unavailable camera tries to reattach to the other's endpoint.
      const unavailable = await prisma.nodeCamera.create({
        data: { nodeId: id, stableId: "usb:32e6:9221:SHAREDSERIAL:path:usb-0:1.9", devicePath: "/dev/video9", name: "webcam 1080P", ...SHARED, available: false, enabled: true },
      });
      await expect(reattachNodeCamera(prisma, { nodeName: NODE, cameraId: unavailable.id, endpointId: otherEndpoint.id })).rejects.toThrow(/already assigned to another active/i);

      // The other camera's assignment is untouched.
      const stillAssigned = await prisma.nodeCameraAssignment.findUniqueOrThrow({ where: { id: attached.assignment.id } });
      expect(stillAssigned.active).toBe(true);
      expect(stillAssigned.nodeCameraId).toBe(other.id);
    });
  });
});
