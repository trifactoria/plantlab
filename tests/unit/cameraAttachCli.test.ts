import { describe, expect, it } from "vitest";
import { updateCameraInventory } from "../../src/lib/operations/agentProtocol";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";
import { runCameraAttachFlow } from "../../src/cli/commands/camera";

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
});
