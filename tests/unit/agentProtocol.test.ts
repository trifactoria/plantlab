import { describe, expect, it } from "vitest";
import {
  claimJob,
  completeJob,
  failJob,
  inventoryDiagnosticsForCamera,
  nextQueuedJob,
  nextServableJob,
  recordHeartbeat,
  requestCameraInventoryRefresh,
  serializeJobForAgent,
  updateCameraInventory,
} from "../../src/lib/operations/agentProtocol";
import { attachNodeCamera, listCameraReattachCandidates, parseNodeCameraFormats, reattachNodeCamera, renameNodeCamera } from "../../src/lib/operations/nodeCameras";
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

  it("keeps camera display names user-owned while inventory updates reported names", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-name-regression", role: "greenhouse-node", rotateCredential: true });
    const [camera] = await updateCameraInventory(prisma, registered.node.id, [
      { stableId: "usb-name-regression", devicePath: "/dev/video0", name: "Reported Webcam" },
    ]);

    await renameNodeCamera(prisma, { nodeName: "greenhouse-zero-name-regression", cameraId: camera.id, name: "User Shelf Camera" });
    await updateCameraInventory(prisma, registered.node.id, [
      { stableId: "usb-name-regression", devicePath: "/dev/video0", name: "Updated Hardware Webcam" },
    ]);

    const current = await prisma.nodeCamera.findUniqueOrThrow({ where: { id: camera.id }, include: { endpoints: true } });
    expect(current.displayName).toBe("User Shelf Camera");
    expect(current.name).toBe("User Shelf Camera");
    expect(current.reportedName).toBe("Updated Hardware Webcam");
    expect(current.endpoints[0].name).toBe("Updated Hardware Webcam");
  });

  it("does not rename assignments or capture sources during inventory refresh", async () => {
    const { registered, attached } = await makeNodeWithAssignment();
    await prisma.captureSource.update({ where: { id: attached.captureSource.id }, data: { name: "User Source Name" } });
    await prisma.nodeCameraAssignment.update({ where: { id: attached.assignment.id }, data: { name: "User Assignment Name" } });

    await updateCameraInventory(prisma, registered.node.id, [
      { stableId: "usb-logitech-1", devicePath: "/dev/video4", name: "New Reported Name" },
    ]);

    await expect(prisma.captureSource.findUniqueOrThrow({ where: { id: attached.captureSource.id } })).resolves.toMatchObject({ name: "User Source Name" });
    await expect(prisma.nodeCameraAssignment.findUniqueOrThrow({ where: { id: attached.assignment.id } })).resolves.toMatchObject({ name: "User Assignment Name" });
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

  it("records endpoint observations and keeps one logical camera for same serial when only /dev path changes", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "camera-endpoint-history", role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:046d:0825:SERIAL1",
        devicePath: "/dev/video0",
        name: "Stable Camera",
        vendorId: "046d",
        productId: "0825",
        serial: "SERIAL1",
      },
    ]);
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:046d:0825:SERIAL1",
        devicePath: "/dev/video4",
        name: "Stable Camera",
        vendorId: "046d",
        productId: "0825",
        serial: "SERIAL1",
      },
    ]);

    const cameras = await prisma.nodeCamera.findMany({ where: { nodeId: registered.node.id } });
    expect(cameras).toHaveLength(1);
    expect(cameras[0].devicePath).toBe("/dev/video4");
    const endpoints = await prisma.nodeCameraEndpoint.findMany({ where: { nodeId: registered.node.id }, orderBy: { devicePath: "asc" } });
    expect(endpoints.map((endpoint) => [endpoint.devicePath, endpoint.available])).toEqual([
      ["/dev/video0", false],
      ["/dev/video4", true],
    ]);
  });

  it("requires explicit reattach for an ambiguous endpoint and preserves assignment config", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "camera-reattach", role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:32e6:9221:fake:path:port-a",
        legacyStableId: "usb:32e6:9221:fake",
        devicePath: "/dev/video0",
        vendorId: "32e6",
        productId: "9221",
        serial: "fake",
        physicalPath: "port-a",
        formatsStatus: "ok",
        formats: [{ pixelFormat: "MJPG", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);
    const attached = await attachNodeCamera(prisma, {
      nodeName: "camera-reattach",
      stableId: "usb:32e6:9221:fake:path:port-a",
      newCaptureSourceName: "Reattach Source",
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
    });
    await prisma.captureSource.update({ where: { id: attached.captureSource.id }, data: { rotation: 90 } });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:32e6:9221:fake:path:port-b",
        legacyStableId: "usb:32e6:9221:fake",
        devicePath: "/dev/video2",
        vendorId: "32e6",
        productId: "9221",
        serial: "fake",
        physicalPath: "port-b",
        formatsStatus: "ok",
        formats: [{ pixelFormat: "MJPG", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);

    const candidates = await listCameraReattachCandidates(prisma, { nodeName: "camera-reattach", cameraId: attached.camera.id });
    expect(candidates[0].confidence).toBe("medium");
    const result = await reattachNodeCamera(prisma, { nodeName: "camera-reattach", cameraId: attached.camera.id, endpointId: candidates[0].endpoint.id });
    expect(result.camera.id).toBe(attached.camera.id);
    expect(result.camera.devicePath).toBe("/dev/video2");
    const assignment = await prisma.nodeCameraAssignment.findUniqueOrThrow({ where: { id: attached.assignment.id }, include: { captureSource: true } });
    expect(assignment.width).toBe(1280);
    expect(assignment.height).toBe(720);
    expect(assignment.inputFormat).toBe("mjpeg");
    expect(assignment.captureSource.rotation).toBe(90);
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
    expect(
      await failJob(prisma, registered.node.id, failed.id, "camera busy", {
        validationStatus: "rejected",
        validationErrorCode: "partial-frame",
        attemptCount: 2,
        fallbackUsed: false,
        attempts: [{ attempt: 1, status: "failed", errorCode: "partial-frame" }],
      }),
    ).toBe(true);
    await expect(prisma.agentCaptureJob.findUnique({ where: { id: failed.id } })).resolves.toMatchObject({
      status: "failed",
      validationStatus: "rejected",
      validationErrorCode: "partial-frame",
      attemptCount: 2,
      fallbackUsed: false,
      attemptsJson: expect.stringContaining("partial-frame"),
    });

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

    const payload = await serializeJobForAgent(prisma, await nextQueuedJob(prisma, registered.node.id));

    expect(payload?.settings).toMatchObject({
      width: 1920,
      height: 1080,
      inputFormat: "mjpeg",
      frameRate: null,
      warmupFrames: 10,
      captureAttempts: 2,
      fallback: null,
      serializeOnNode: true,
    });
  });

  it("resolves the current device path from latest NodeCamera inventory by stable ID immediately before dispatch", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-job-device-move", role: "greenhouse-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:32e6:9221:serial:path:1.3",
        devicePath: "/dev/video0",
        name: "Greenhouse Camera 1.3",
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);
    const attached = await attachNodeCamera(prisma, {
      nodeName: "greenhouse-job-device-move",
      stableId: "usb:32e6:9221:serial:path:1.3",
      newCaptureSourceName: "Greenhouse Stable Camera",
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
    });
    await prisma.agentCaptureJob.create({
      data: {
        nodeId: registered.node.id,
        assignmentId: attached.assignment.id,
        captureSourceId: attached.captureSource.id,
      },
    });

    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:32e6:9221:serial:path:1.3",
        devicePath: "/dev/video2",
        name: "Greenhouse Camera 1.3",
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);

    const payload = await serializeJobForAgent(prisma, await nextQueuedJob(prisma, registered.node.id));

    expect(attached.captureSource.cameraDevice).toBe("/dev/video0");
    expect(payload?.camera).toMatchObject({
      stableId: "usb:32e6:9221:serial:path:1.3",
      devicePath: "/dev/video2",
    });
  });

  it("does not dispatch a queued job when the assigned stable camera is not available in current inventory", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-job-unavailable", role: "greenhouse-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb:missing-camera",
        devicePath: "/dev/video0",
        name: "Missing Camera",
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);
    const attached = await attachNodeCamera(prisma, {
      nodeName: "greenhouse-job-unavailable",
      stableId: "usb:missing-camera",
      newCaptureSourceName: "Unavailable Camera",
      width: 1280,
      height: 720,
      inputFormat: "mjpeg",
    });
    await prisma.agentCaptureJob.create({
      data: {
        nodeId: registered.node.id,
        assignmentId: attached.assignment.id,
        captureSourceId: attached.captureSource.id,
      },
    });
    await prisma.nodeCamera.update({ where: { id: attached.camera.id }, data: { available: false, devicePath: "/dev/video0" } });

    await expect(serializeJobForAgent(prisma, await nextQueuedJob(prisma, registered.node.id))).resolves.toBeNull();
  });

  describe("nextServableJob", () => {
    it("explicitly fails a stale queued job whose camera became unavailable, rather than leaving it queued forever", async () => {
      const registered = await registerOrRotateNode(prisma, { name: "greenhouse-servable-stale", role: "greenhouse-node", rotateCredential: true });
      await updateCameraInventory(prisma, registered.node.id, [
        { stableId: "usb:stale-camera", devicePath: "/dev/video0", name: "Stale Camera", formats: [] },
      ]);
      const attached = await attachNodeCamera(prisma, {
        nodeName: "greenhouse-servable-stale",
        stableId: "usb:stale-camera",
        newCaptureSourceName: "Stale Camera Source",
        width: 1280,
        height: 720,
        inputFormat: "mjpeg",
      });
      const job = await prisma.agentCaptureJob.create({
        data: { nodeId: registered.node.id, assignmentId: attached.assignment.id, captureSourceId: attached.captureSource.id },
      });
      // Simulates a USB reconnect that shifted the camera to a new physical
      // path - the coordinator now considers this stableId unavailable.
      await prisma.nodeCamera.update({ where: { id: attached.camera.id }, data: { available: false } });

      await expect(nextServableJob(prisma, registered.node.id)).resolves.toBeNull();

      const updated = await prisma.agentCaptureJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(updated.status).toBe("failed");
      expect(updated.errorMessage).toMatch(/no longer available/i);
    });

    it("skips a stale unavailable-camera job at the head of the queue and serves the next job behind it", async () => {
      const registered = await registerOrRotateNode(prisma, { name: "greenhouse-servable-skip", role: "greenhouse-node", rotateCredential: true });
      await updateCameraInventory(prisma, registered.node.id, [
        { stableId: "usb:stale-camera", devicePath: "/dev/video0", name: "Stale Camera", formats: [] },
        { stableId: "usb:fresh-camera", devicePath: "/dev/video2", name: "Fresh Camera", formats: [] },
      ]);
      const staleAttached = await attachNodeCamera(prisma, {
        nodeName: "greenhouse-servable-skip",
        stableId: "usb:stale-camera",
        newCaptureSourceName: "Stale Camera Source",
        width: 1280,
        height: 720,
        inputFormat: "mjpeg",
      });
      const freshAttached = await attachNodeCamera(prisma, {
        nodeName: "greenhouse-servable-skip",
        stableId: "usb:fresh-camera",
        newCaptureSourceName: "Fresh Camera Source",
        width: 1280,
        height: 720,
        inputFormat: "mjpeg",
      });
      // The stale job was queued first (head of the FIFO queue); the fresh
      // one was queued afterward, e.g. from a later "Capture Test Frame" click.
      const staleJob = await prisma.agentCaptureJob.create({
        data: { nodeId: registered.node.id, assignmentId: staleAttached.assignment.id, captureSourceId: staleAttached.captureSource.id },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const freshJob = await prisma.agentCaptureJob.create({
        data: { nodeId: registered.node.id, assignmentId: freshAttached.assignment.id, captureSourceId: freshAttached.captureSource.id },
      });
      await prisma.nodeCamera.update({ where: { id: staleAttached.camera.id }, data: { available: false } });

      // The naive single-job fetch would return the stale job forever and
      // never reach the fresh one behind it - this is the head-of-line
      // blocking bug nextServableJob() fixes.
      const naiveNext = await nextQueuedJob(prisma, registered.node.id);
      expect(naiveNext?.id).toBe(staleJob.id);
      await expect(serializeJobForAgent(prisma, naiveNext)).resolves.toBeNull();

      const servable = await nextServableJob(prisma, registered.node.id);
      expect(servable?.id).toBe(freshJob.id);

      const staleUpdated = await prisma.agentCaptureJob.findUniqueOrThrow({ where: { id: staleJob.id } });
      expect(staleUpdated.status).toBe("failed");
      const freshUpdated = await prisma.agentCaptureJob.findUniqueOrThrow({ where: { id: freshJob.id } });
      expect(freshUpdated.status).toBe("queued");
    });

    it("returns null when there are no queued jobs at all", async () => {
      const registered = await registerOrRotateNode(prisma, { name: "greenhouse-servable-empty", role: "greenhouse-node", rotateCredential: true });
      await expect(nextServableJob(prisma, registered.node.id)).resolves.toBeNull();
    });
  });
});
