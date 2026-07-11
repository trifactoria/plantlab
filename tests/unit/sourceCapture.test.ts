import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { isUniqueConstraintError } from "../../src/lib/prismaErrors";
import { getCaptureSourceSettings } from "../../src/lib/sourceCapture";
import { cleanupTestCaptureSource, createTestCaptureSource } from "./helpers/testCaptureSource";

describe("getCaptureSourceSettings", () => {
  const created: Array<{ id: string; directory: string }> = [];

  afterEach(async () => {
    for (const { id, directory } of created.splice(0)) {
      await cleanupTestCaptureSource(prisma, id, directory);
    }
  });

  async function source(overrides: Parameters<typeof createTestCaptureSource>[1] = {}) {
    const result = await createTestCaptureSource(prisma, overrides);
    created.push({ id: result.id, directory: result.captureDirectory });
    return result;
  }

  it("requests the raw (pre-rotation) dimensions from the device for a 0-degree source", async () => {
    const captureSource = await source({ width: 3840, height: 2160, rotation: 0 });
    const settings = getCaptureSourceSettings(captureSource);

    expect(settings.width).toBe(3840);
    expect(settings.height).toBe(2160);
    expect(settings.workingWidth).toBe(3840);
    expect(settings.workingHeight).toBe(2160);
  });

  it("requests swapped raw dimensions from the device for a 90-degree source, since CaptureSource stores the transformed working size", async () => {
    // Working (post-rotation) frame is 2160 wide x 3840 tall.
    const captureSource = await source({ width: 2160, height: 3840, rotation: 90 });
    const settings = getCaptureSourceSettings(captureSource);

    expect(settings.width).toBe(3840);
    expect(settings.height).toBe(2160);
    expect(settings.workingWidth).toBe(2160);
    expect(settings.workingHeight).toBe(3840);
  });

  it("throws for a stored rotation outside 0/90/180/270", async () => {
    const captureSource = await source({ rotation: 0 });
    // Simulating corrupted/legacy data - the DB column is a plain Int, not a checked enum.
    captureSource.rotation = 45;
    expect(() => getCaptureSourceSettings(captureSource)).toThrow(/Unsupported rotation/);
  });
});

describe("SourceCapture duplicate-slot prevention", () => {
  const created: Array<{ id: string; directory: string }> = [];

  afterEach(async () => {
    for (const { id, directory } of created.splice(0)) {
      await cleanupTestCaptureSource(prisma, id, directory);
    }
  });

  it("rejects a second SourceCapture for the same source + scheduledFor slot", async () => {
    const captureSource = await createTestCaptureSource(prisma);
    created.push({ id: captureSource.id, directory: captureSource.captureDirectory });
    const scheduledFor = new Date("2026-07-11T18:00:00.000Z");

    await prisma.sourceCapture.create({
      data: {
        captureSourceId: captureSource.id,
        timestamp: new Date(),
        scheduledFor,
        originalPath: "/tmp/a.jpg",
        originalWidth: 100,
        originalHeight: 100,
        workingWidth: 100,
        workingHeight: 100,
        pixelFormat: "mjpeg",
      },
    });

    await expect(
      prisma.sourceCapture.create({
        data: {
          captureSourceId: captureSource.id,
          timestamp: new Date(),
          scheduledFor,
          originalPath: "/tmp/b.jpg",
          originalWidth: 100,
          originalHeight: 100,
          workingWidth: 100,
          workingHeight: 100,
          pixelFormat: "mjpeg",
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isUniqueConstraintError(error));
  });

  it("allows multiple manual (scheduledFor: null) captures for the same source without collision", async () => {
    const captureSource = await createTestCaptureSource(prisma);
    created.push({ id: captureSource.id, directory: captureSource.captureDirectory });

    for (let i = 0; i < 3; i += 1) {
      await prisma.sourceCapture.create({
        data: {
          captureSourceId: captureSource.id,
          timestamp: new Date(),
          scheduledFor: null,
          originalPath: `/tmp/manual-${i}.jpg`,
          originalWidth: 100,
          originalHeight: 100,
          workingWidth: 100,
          workingHeight: 100,
          pixelFormat: "mjpeg",
        },
      });
    }

    await expect(prisma.sourceCapture.count({ where: { captureSourceId: captureSource.id } })).resolves.toBe(3);
  });

  it("allows the same scheduledFor slot across two different capture sources", async () => {
    const sourceA = await createTestCaptureSource(prisma);
    const sourceB = await createTestCaptureSource(prisma);
    created.push({ id: sourceA.id, directory: sourceA.captureDirectory });
    created.push({ id: sourceB.id, directory: sourceB.captureDirectory });
    const scheduledFor = new Date("2026-07-11T19:00:00.000Z");

    for (const captureSource of [sourceA, sourceB]) {
      await prisma.sourceCapture.create({
        data: {
          captureSourceId: captureSource.id,
          timestamp: new Date(),
          scheduledFor,
          originalPath: `/tmp/${captureSource.id}.jpg`,
          originalWidth: 100,
          originalHeight: 100,
          workingWidth: 100,
          workingHeight: 100,
          pixelFormat: "mjpeg",
        },
      });
    }

    await expect(prisma.sourceCapture.count({ where: { scheduledFor } })).resolves.toBe(2);
  });
});
