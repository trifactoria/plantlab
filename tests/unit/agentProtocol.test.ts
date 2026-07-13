import { describe, expect, it } from "vitest";
import {
  claimJob,
  completeJob,
  failJob,
  inventoryDiagnosticsForCamera,
  nextQueuedJob,
  recordHeartbeat,
  requestCameraInventoryRefresh,
  serializeJobForAgent,
  updateCameraInventory,
} from "../../src/lib/operations/agentProtocol";
import { attachNodeCamera, parseNodeCameraFormats } from "../../src/lib/operations/nodeCameras";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

async function makeNodeWithAssignment() {
  const registered = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });
  await updateCameraInventory(prisma, registered.node.id, [
    {
      stableId: "usb-logitech-1",
      devicePath: "/dev/video4",
      name: "Logitech Camera",
      formats: [
        {
          pixelFormat: "mjpeg",
          description: "Motion-JPEG",
          resolutions: [
            { width: 1280, height: 720, frameRates: ["30 fps"] },
            { width: 1920, height: 1080, frameRates: ["30 fps"] },
          ],
        },
      ],
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

  it("stores normalized structured camera inventory without dropping MJPEG or YUYV families", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-inventory", role: "greenhouse-node", rotateCredential: true });
    const [camera] = await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-greenhouse-cam",
        devicePath: "/dev/video0",
        name: "Greenhouse Camera",
        formats: [
          {
            pixelFormat: "MJPG",
            description: "Motion-JPEG",
            resolutions: [
              { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
              { width: 1280, height: 720, frameRates: ["30.000 fps"] },
            ],
          },
          {
            pixelFormat: "YUYV",
            description: "YUYV 4:2:2",
            resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
          },
        ],
      },
    ]);

    expect(parseNodeCameraFormats(camera)).toEqual([
      {
        pixelFormat: "mjpeg",
        description: "Motion-JPEG",
        resolutions: [
          { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
          { width: 1280, height: 720, frameRates: ["30.000 fps"] },
        ],
      },
      {
        pixelFormat: "yuyv422",
        description: "YUYV 4:2:2",
        resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
      },
    ]);
  });

  it("stores greenhouse-zero recorded MJPEG and YUYV inventory as distinct verified mode tuples", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-recorded", role: "greenhouse-node", rotateCredential: true });
    const [camera] = await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-greenhouse-zero",
        devicePath: "/dev/video0",
        name: "greenhouse-zero webcam",
        formatsStatus: "ok",
        formats: [
          {
            pixelFormat: "MJPG",
            description: "Motion-JPEG",
            resolutions: [
              { width: 1920, height: 1080, frameRates: ["30 fps"] },
              { width: 1280, height: 720, frameRates: ["30 fps"] },
              { width: 800, height: 600, frameRates: ["30 fps"] },
              { width: 640, height: 480, frameRates: ["30 fps"] },
              { width: 640, height: 360, frameRates: ["30 fps"] },
            ],
          },
          {
            pixelFormat: "YUYV",
            description: "YUYV 4:2:2",
            resolutions: [
              { width: 1920, height: 1080, frameRates: ["5 fps"] },
              { width: 1280, height: 720, frameRates: ["10 fps"] },
              { width: 800, height: 600, frameRates: ["20 fps"] },
              { width: 640, height: 480, frameRates: ["30 fps"] },
              { width: 640, height: 360, frameRates: ["30 fps"] },
            ],
          },
        ],
      },
    ]);

    const formats = parseNodeCameraFormats(camera);
    expect(formats).toHaveLength(2);
    expect(formats[0].pixelFormat).toBe("mjpeg");
    expect(formats[0].resolutions.map((resolution) => `${resolution.width}x${resolution.height}@${resolution.frameRates.join(",")}`)).toEqual([
      "1920x1080@30 fps",
      "1280x720@30 fps",
      "800x600@30 fps",
      "640x480@30 fps",
      "640x360@30 fps",
    ]);
    expect(formats[1].pixelFormat).toBe("yuyv422");
    expect(formats[1].resolutions.map((resolution) => `${resolution.width}x${resolution.height}@${resolution.frameRates.join(",")}`)).toEqual([
      "1920x1080@5 fps",
      "1280x720@10 fps",
      "800x600@20 fps",
      "640x480@30 fps",
      "640x360@30 fps",
    ]);
    expect(inventoryDiagnosticsForCamera(camera)).toMatchObject({
      formatsReceivedCount: 2,
      modesReceivedCount: 10,
      formatsJsonEmpty: false,
    });
  });

  it("does not erase a complete stored camera inventory when a later legacy report omits formats", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-empty-regression", role: "greenhouse-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-greenhouse-zero",
        devicePath: "/dev/video0",
        name: "greenhouse-zero webcam",
        formatsStatus: "ok",
        formats: [
          {
            pixelFormat: "MJPG",
            description: "Motion-JPEG",
            resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }],
          },
          {
            pixelFormat: "YUYV",
            description: "YUYV 4:2:2",
            resolutions: [{ width: 640, height: 480, frameRates: ["30 fps"] }],
          },
        ],
      },
    ]);

    const [camera] = await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-greenhouse-zero",
        devicePath: "/dev/video0",
        name: "greenhouse-zero webcam",
        available: true,
        formats: [],
      },
    ]);

    expect(parseNodeCameraFormats(camera)).toEqual([
      {
        pixelFormat: "mjpeg",
        description: "Motion-JPEG",
        resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }],
      },
      {
        pixelFormat: "yuyv422",
        description: "YUYV 4:2:2",
        resolutions: [{ width: 640, height: 480, frameRates: ["30 fps"] }],
      },
    ]);
  });

  it("clears a pending manual inventory refresh after the node reports inventory", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-refresh", role: "greenhouse-node", rotateCredential: true });
    const requested = await requestCameraInventoryRefresh(prisma, "greenhouse-zero-refresh");
    expect(requested.inventoryRefreshRequestedAt).toBeTruthy();

    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-refresh",
        devicePath: "/dev/video0",
        name: "Refresh Camera",
        formatsStatus: "ok",
        formats: [{ pixelFormat: "MJPG", description: "Motion-JPEG", resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }] }],
      },
    ]);

    const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id } });
    expect(node.lastInventoryAt).toBeTruthy();
    expect(node.inventoryRefreshRequestedAt).toBeNull();
  });

  it("reconciles an old duplicate-serial stable ID onto the matching new physical camera without attaching the second camera", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-duplicate-reconcile", role: "greenhouse-node", rotateCredential: true });
    const legacyStableId = "usb:32e6:9221:202601081445001";
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: legacyStableId,
        devicePath: "/dev/video0",
        name: "webcam 1080P",
        formatsStatus: "ok",
        formats: [{ pixelFormat: "MJPG", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);
    const attached = await attachNodeCamera(prisma, {
      nodeName: "greenhouse-zero-duplicate-reconcile",
      stableId: legacyStableId,
      newCaptureSourceName: "Greenhouse Existing Camera",
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
    });

    const [cameraA, cameraB] = await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.3",
        legacyStableId,
        devicePath: "/dev/video0",
        name: "webcam 1080P (1.3)",
        vendorId: "32e6",
        productId: "9221",
        serial: "202601081445001",
        physicalPath: "platform-20980000.usb-usb-0:1.3",
        usbPath: "platform-20980000.usb-usb-0:1.3",
        usbPort: "1.3",
        alternateDevices: [{ device: "/dev/video1", supportsCapture: false, reason: "not capture-capable" }],
        formatsStatus: "ok",
        formats: [{ pixelFormat: "MJPG", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
      {
        stableId: "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.2",
        legacyStableId,
        devicePath: "/dev/video2",
        name: "webcam 1080P (1.2)",
        vendorId: "32e6",
        productId: "9221",
        serial: "202601081445001",
        physicalPath: "platform-20980000.usb-usb-0:1.2",
        usbPath: "platform-20980000.usb-usb-0:1.2",
        usbPort: "1.2",
        alternateDevices: [{ device: "/dev/video3", supportsCapture: false, reason: "not capture-capable" }],
        formatsStatus: "ok",
        formats: [{ pixelFormat: "MJPG", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);

    expect(cameraA.id).toBe(attached.camera.id);
    expect(cameraA.stableId).toContain(":path:platform-20980000.usb-usb-0:1.3");
    expect(cameraA.captureSourceId).toBe(attached.captureSource.id);
    expect(cameraB.id).not.toBe(attached.camera.id);
    expect(cameraB.captureSourceId).toBeNull();

    const assignment = await prisma.nodeCameraAssignment.findUniqueOrThrow({
      where: { id: attached.assignment.id },
      include: { nodeCamera: true, captureSource: true },
    });
    expect(assignment.nodeCameraId).toBe(cameraA.id);
    expect(assignment.nodeCamera.stableId).toBe(cameraA.stableId);
    expect(assignment.captureSourceId).toBe(attached.captureSource.id);
    expect(assignment.captureSource.name).toBe("Greenhouse Existing Camera");

    const old = await prisma.nodeCamera.findUnique({ where: { nodeId_stableId: { nodeId: registered.node.id, stableId: legacyStableId } } });
    expect(old).toBeNull();
  });

  it("records runtime, protocol version, and reported capabilities from a heartbeat (Part 6/8/13)", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero", role: "greenhouse-node", rotateCredential: true });
    await recordHeartbeat(prisma, registered.node.id, {
      hostname: "greenhouse-zero",
      role: "greenhouse-node",
      operatingSystem: "Raspberry Pi OS Lite",
      architecture: "armv6l",
      softwareVersion: "0.1.0",
      runtime: "python-edge",
      protocolVersion: "1",
      capabilities: ["camera"],
    });

    const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id } });
    expect(node.runtime).toBe("python-edge");
    expect(node.protocolVersion).toBe("1");
    expect(JSON.parse(node.capabilitiesJson)).toEqual(["camera"]);
  });

  it("a heartbeat's reported capabilities replace, not merge with, whatever was seeded at registration", async () => {
    const registered = await registerOrRotateNode(prisma, {
      name: "capability-node",
      role: "greenhouse-node",
      rotateCredential: true,
      capabilities: ["camera", "temperature"],
    });
    let node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id } });
    expect(JSON.parse(node.capabilitiesJson).sort()).toEqual(["camera", "temperature"]);

    await recordHeartbeat(prisma, registered.node.id, { capabilities: ["camera"] });
    node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id } });
    expect(JSON.parse(node.capabilitiesJson)).toEqual(["camera"]);
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

  it("rejects an attachment mode that crosses format-specific resolution families", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy-invalid-mode", role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-bokchoy",
        devicePath: "/dev/video0",
        name: "Bokchoy Camera",
        formats: [
          { pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] },
          { pixelFormat: "yuyv422", description: "YUYV 4:2:2", resolutions: [{ width: 640, height: 480, frameRates: ["30 fps"] }] },
        ],
      },
    ]);

    await expect(
      attachNodeCamera(prisma, {
        nodeName: "bokchoy-invalid-mode",
        stableId: "usb-bokchoy",
        newCaptureSourceName: "Invalid Combo",
        width: 640,
        height: 480,
        inputFormat: "mjpeg",
      }),
    ).rejects.toThrow(/does not advertise MJPEG 640x480/);
  });

  it("serializes the selected assignment mode unchanged into the agent job payload", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-job-mode", role: "greenhouse-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-greenhouse-job",
        devicePath: "/dev/video0",
        name: "Greenhouse Camera",
        formats: [
          { pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }] },
          { pixelFormat: "yuyv422", description: "YUYV 4:2:2", resolutions: [{ width: 640, height: 480, frameRates: ["30 fps"] }] },
        ],
      },
    ]);
    const attached = await attachNodeCamera(prisma, {
      nodeName: "greenhouse-job-mode",
      stableId: "usb-greenhouse-job",
      newCaptureSourceName: "Greenhouse Job Camera",
      width: 1920,
      height: 1080,
      inputFormat: "mjpeg",
    });
    await prisma.agentCaptureJob.create({
      data: {
        nodeId: registered.node.id,
        assignmentId: attached.assignment.id,
        captureSourceId: attached.captureSource.id,
      },
    });

    const payload = serializeJobForAgent(await nextQueuedJob(prisma, registered.node.id));

    expect(payload?.settings).toEqual({ width: 1920, height: 1080, inputFormat: "mjpeg" });
  });
});
