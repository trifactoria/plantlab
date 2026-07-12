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
});
