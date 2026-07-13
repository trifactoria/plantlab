import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";
import { runCameraAttachFlow } from "../../src/cli/commands/camera";

const CLI_PATH = path.join(__dirname, "..", "..", "bin", "plantlab");

function runCli(args: string[]) {
  return spawnSync(CLI_PATH, args, { encoding: "utf8", env: process.env });
}

describe("camera attach CLI flow", () => {
  it("does not consume destination choice 2 as the new capture-source name", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy", role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-integrated",
        devicePath: "/dev/video0",
        name: "Integrated Webcam",
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
    ]);

    const answers = ["2", "", "1"];
    const prompts: string[] = [];
    const result = await runCameraAttachFlow({
      node: "bokchoy",
      camera: "1",
      interactive: true,
      prompt: async (question) => {
        prompts.push(question);
        return answers.shift() ?? "";
      },
    });

    expect(prompts[0]).toContain("Choice [1-2");
    expect(prompts[1]).toContain("Capture source name");
    expect(result.captureSource.name).toBe("bokchoy Integrated Webcam");
    expect(result.captureSource.name).not.toBe("2");
  });

  it("does not silently reuse an existing capture source that looks accidental, and offers to create a new one instead", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy2", role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-integrated",
        devicePath: "/dev/video0",
        name: "Integrated Webcam",
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
    ]);
    const accidental = await prisma.captureSource.create({
      data: {
        name: "77",
        cameraDevice: "/dev/video1",
        captureDirectory: "/tmp/plantlab-test-source-2",
        width: 1280,
        height: 720,
        photoIntervalMinutes: 60,
      },
    });
    const orderedNames = (await prisma.captureSource.findMany({ orderBy: { name: "asc" }, select: { name: true } })).map((s) => s.name);
    const sourceChoice = String(orderedNames.indexOf("77") + 1);

    const answers = ["1", sourceChoice, "", "", "1"];
    const prompts: string[] = [];
    const result = await runCameraAttachFlow({
      node: "bokchoy2",
      camera: "1",
      interactive: true,
      prompt: async (question) => {
        prompts.push(question);
        return answers.shift() ?? "";
      },
    });

    expect(prompts.some((question) => question.includes('Rename "77" to'))).toBe(false);
    expect(prompts.some((question) => question.startsWith("Choice [1-3"))).toBe(true);
    expect(result.captureSource.id).not.toBe(accidental.id);
    expect(result.captureSource.name).toBe("bokchoy2 Integrated Webcam");
  });

  it("offers to rename an accidental existing capture source and reuses it when the user chooses to", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy3", role: "camera-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-integrated",
        devicePath: "/dev/video0",
        name: "Integrated Webcam",
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
    ]);
    const accidental = await prisma.captureSource.create({
      data: {
        name: "88",
        cameraDevice: "/dev/video1",
        captureDirectory: "/tmp/plantlab-test-source-3",
        width: 1280,
        height: 720,
        photoIntervalMinutes: 60,
      },
    });
    const orderedNames = (await prisma.captureSource.findMany({ orderBy: { name: "asc" }, select: { name: true } })).map((s) => s.name);
    const sourceChoice = String(orderedNames.indexOf("88") + 1);

    const answers = ["1", sourceChoice, "3", "Bokchoy Front Camera", "1"];
    const result = await runCameraAttachFlow({
      node: "bokchoy3",
      camera: "1",
      interactive: true,
      prompt: async () => answers.shift() ?? "",
    });

    expect(result.captureSource.id).toBe(accidental.id);
    expect(result.captureSource.name).toBe("Bokchoy Front Camera");
  });

  it("prints stored node camera modes and diagnostics in verbose coordinator camera info", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero", role: "greenhouse-node", rotateCredential: true });
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: "usb-greenhouse-zero",
        devicePath: "/dev/video0",
        name: "Greenhouse Camera",
        formatsStatus: "ok",
        formats: [
          {
            pixelFormat: "MJPG",
            description: "Motion-JPEG",
            resolutions: [
              { width: 1920, height: 1080, frameRates: ["30 fps"] },
              { width: 1280, height: 720, frameRates: ["30 fps"] },
            ],
          },
          {
            pixelFormat: "YUYV",
            description: "YUYV 4:2:2",
            resolutions: [{ width: 640, height: 480, frameRates: ["30 fps"] }],
          },
        ],
      },
    ]);

    const result = runCli(["camera", "info", "--node", "greenhouse-zero"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Node: greenhouse-zero");
    expect(result.stdout).toContain("Last inventory:");
    expect(result.stdout).toContain("Formats: 2; modes: 3; formatsJson empty: no");
    expect(result.stdout).toContain("MJPEG 1920x1080 @ 30 fps");
    expect(result.stdout).toContain("YUYV 640x480 @ 30 fps");
  });

  it("shows duplicate-serial webcams with friendly USB suffixes and attaches the second camera independently", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero-dual-webcam", role: "greenhouse-node", rotateCredential: true });
    const legacyStableId = "usb:32e6:9221:202601081445001";
    await updateCameraInventory(prisma, registered.node.id, [
      {
        stableId: `${legacyStableId}:path:platform-20980000.usb-usb-0:1.3`,
        legacyStableId,
        devicePath: "/dev/video0",
        name: "webcam 1080P (1.3)",
        vendorId: "32e6",
        productId: "9221",
        serial: "202601081445001",
        physicalPath: "platform-20980000.usb-usb-0:1.3",
        usbPort: "1.3",
        alternateDevices: [{ device: "/dev/video1", supportsCapture: false, reason: "not capture-capable" }],
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
      {
        stableId: `${legacyStableId}:path:platform-20980000.usb-usb-0:1.2`,
        legacyStableId,
        devicePath: "/dev/video2",
        name: "webcam 1080P (1.2)",
        vendorId: "32e6",
        productId: "9221",
        serial: "202601081445001",
        physicalPath: "platform-20980000.usb-usb-0:1.2",
        usbPort: "1.2",
        alternateDevices: [{ device: "/dev/video3", supportsCapture: false, reason: "not capture-capable" }],
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: ["30 fps"] }] }],
      },
    ]);
    const first = await runCameraAttachFlow({
      node: "greenhouse-zero-dual-webcam",
      camera: `${legacyStableId}:path:platform-20980000.usb-usb-0:1.3`,
      name: "Greenhouse Camera 1.3",
      width: 1280,
      height: 720,
      format: "mjpeg",
      yes: true,
    });

    const info = runCli(["camera", "list", "--node", "greenhouse-zero-dual-webcam", "--verbose"]);
    expect(info.status).toBe(0);
    expect(info.stdout).toContain("webcam 1080P (1.3)");
    expect(info.stdout).toContain("Primary: /dev/video0");
    expect(info.stdout).toContain("Alternate: /dev/video1");
    expect(info.stdout).toContain("webcam 1080P (1.2)");
    expect(info.stdout).toContain("Primary: /dev/video2");
    expect(info.stdout).toContain("Alternate: /dev/video3");

    const second = await runCameraAttachFlow({
      node: "greenhouse-zero-dual-webcam",
      camera: `${legacyStableId}:path:platform-20980000.usb-usb-0:1.2`,
      name: "Greenhouse Camera 1.2",
      width: 1280,
      height: 720,
      format: "mjpeg",
      yes: true,
    });

    expect(second.captureSource.id).not.toBe(first.captureSource.id);
    expect(second.assignment.nodeCameraId).not.toBe(first.assignment.nodeCameraId);
    expect(second.camera.devicePath).toBe("/dev/video2");
    const firstAfter = await prisma.nodeCameraAssignment.findUniqueOrThrow({
      where: { id: first.assignment.id },
      include: { nodeCamera: true, captureSource: true },
    });
    expect(firstAfter.nodeCamera.devicePath).toBe("/dev/video0");
    expect(firstAfter.captureSource.name).toBe("Greenhouse Camera 1.3");
  });
});
