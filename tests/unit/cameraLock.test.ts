import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isCameraBusy, withCameraLock } from "../../src/lib/cameraLock";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withCameraLock", () => {
  it("serializes concurrent jobs for the same device", async () => {
    const device = `/dev/video-${randomUUID()}`;
    const order: string[] = [];

    const first = withCameraLock(device, async () => {
      order.push("first-start");
      await delay(30);
      order.push("first-end");
    });
    const second = withCameraLock(device, async () => {
      order.push("second-start");
      await delay(5);
      order.push("second-end");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("runs jobs for different devices concurrently", async () => {
    const deviceA = `/dev/video-${randomUUID()}`;
    const deviceB = `/dev/video-${randomUUID()}`;
    const order: string[] = [];

    const a = withCameraLock(deviceA, async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    });
    const b = withCameraLock(deviceB, async () => {
      order.push("b-start");
      await delay(5);
      order.push("b-end");
    });

    await Promise.all([a, b]);

    // b (shorter) finishes before a (longer) because they ran in parallel,
    // not queued behind one another.
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });

  it("releases the lock after a failure so the next job still runs", async () => {
    const device = `/dev/video-${randomUUID()}`;

    await expect(
      withCameraLock(device, async () => {
        throw new Error("capture failed");
      }),
    ).rejects.toThrow("capture failed");

    let ran = false;
    await withCameraLock(device, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("reports busy status only while a job is running", async () => {
    const device = `/dev/video-${randomUUID()}`;
    expect(isCameraBusy(device)).toBe(false);

    const job = withCameraLock(device, async () => {
      expect(isCameraBusy(device)).toBe(true);
      await delay(10);
    });

    await job;
    expect(isCameraBusy(device)).toBe(false);
  });
});
