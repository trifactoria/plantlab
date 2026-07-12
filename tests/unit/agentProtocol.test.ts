import { describe, expect, it } from "vitest";
import { claimJob, completeJob, failJob, recordHeartbeat, updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { attachNodeCamera } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

async function makeNodeWithAssignment() {
  const registered = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });
  await updateCameraInventory(prisma, registered.node.id, [
    {
      stableId: "usb-logitech-1",
      devicePath: "/dev/video4",
      name: "Logitech Camera",
      formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
    },
  ]);
  const attached = await attachNodeCamera(prisma, {
    nodeName: "xps",
    stableId: "usb-logitech-1",
    newCaptureSourceName: "XPS Test Camera",
    width: 1280,
    height: 720,
    inputFormat: "mjpeg",
  });
  return { registered, attached };
}

describe("agent protocol", () => {
  it("updates heartbeat and camera inventory idempotently by stable camera identity", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });
    await recordHeartbeat(prisma, registered.node.id, {
      hostname: "xps-host",
      role: "camera-node",
      operatingSystem: "Ubuntu",
      architecture: "x64",
      softwareVersion: "0.1.0",
    });
    await updateCameraInventory(prisma, registered.node.id, [{ stableId: "stable", devicePath: "/dev/video4", name: "Camera" }]);
    await updateCameraInventory(prisma, registered.node.id, [{ stableId: "stable", devicePath: "/dev/video8", name: "Camera" }]);

    const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id }, include: { cameras: true } });
    expect(node.lastHeartbeatAt).toBeTruthy();
    expect(node.cameras).toHaveLength(1);
    expect(node.cameras[0].devicePath).toBe("/dev/video8");
  });

  it("claims, fails, and completes manual jobs with duplicate claim protection", async () => {
    const { registered, attached } = await makeNodeWithAssignment();
    const failed = await prisma.agentCaptureJob.create({
      data: {
        nodeId: registered.node.id,
        assignmentId: attached.assignment.id,
        captureSourceId: attached.captureSource.id,
      },
    });
    expect(await claimJob(prisma, registered.node.id, failed.id, "capture-fail")).toBeTruthy();
    expect(await claimJob(prisma, registered.node.id, failed.id, "duplicate")).toBeNull();
    expect(await failJob(prisma, registered.node.id, failed.id, "camera busy")).toBe(true);

    const completed = await prisma.agentCaptureJob.create({
      data: {
        nodeId: registered.node.id,
        assignmentId: attached.assignment.id,
        captureSourceId: attached.captureSource.id,
      },
    });
    await claimJob(prisma, registered.node.id, completed.id, "capture-ok");
    const sourceCapture = await prisma.sourceCapture.create({
      data: {
        captureSourceId: attached.captureSource.id,
        timestamp: new Date(),
        originalPath: "/tmp/capture-ok.jpg",
        originalWidth: 1280,
        originalHeight: 720,
        workingWidth: 1280,
        workingHeight: 720,
        pixelFormat: "mjpeg",
        captureId: "capture-ok",
        sha256: "a".repeat(64),
        byteSize: 10,
        mimeType: "image/jpeg",
        ingestSource: "http-agent-ingest",
      },
    });

    const result = await completeJob(prisma, registered.node.id, completed.id, "capture-ok");
    expect(result).toMatchObject({ ok: true, sourceCapture: { id: sourceCapture.id } });
  });

  it("keeps camera attachment idempotent for the same node camera and capture source", async () => {
    const { attached } = await makeNodeWithAssignment();
    const rerun = await attachNodeCamera(prisma, {
      nodeName: "xps",
      stableId: "usb-logitech-1",
      captureSourceId: attached.captureSource.id,
      width: 1920,
      height: 1080,
      inputFormat: "mjpeg",
    });

    const assignments = await prisma.nodeCameraAssignment.findMany({
      where: { nodeId: attached.node.id, nodeCameraId: attached.camera.id, captureSourceId: attached.captureSource.id },
    });
    expect(rerun.assignment.id).toBe(attached.assignment.id);
    expect(rerun.createdAssignment).toBe(false);
    expect(rerun.assignment.width).toBe(1920);
    expect(assignments).toHaveLength(1);
  });
});
