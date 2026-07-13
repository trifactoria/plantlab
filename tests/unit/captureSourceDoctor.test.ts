import { describe, expect, it } from "vitest";
import {
  deleteEmptyCaptureSource,
  findSuspiciousCaptureSources,
  inspectCaptureSourceByIdOrName,
  looksLikeAccidentalName,
  renameCaptureSource,
} from "../../src/lib/operations/captureSourceDoctor";
import { prisma } from "../../src/lib/prisma";

async function createSource(overrides: Partial<{ name: string; createdAt: Date }> = {}) {
  return prisma.captureSource.create({
    data: {
      name: overrides.name ?? "2",
      cameraDevice: "/dev/video1",
      captureDirectory: "/tmp/plantlab-test-source",
      width: 1280,
      height: 720,
      photoIntervalMinutes: 60,
      createdAt: overrides.createdAt ?? new Date(),
    },
  });
}

describe("looksLikeAccidentalName", () => {
  it("flags bare numbers and empty/placeholder names", () => {
    expect(looksLikeAccidentalName("2")).toBe(true);
    expect(looksLikeAccidentalName("")).toBe(true);
    expect(looksLikeAccidentalName("   ")).toBe(true);
    expect(looksLikeAccidentalName("New")).toBe(true);
    expect(looksLikeAccidentalName("Untitled")).toBe(true);
  });

  it("does not flag a real, intentional-looking name", () => {
    expect(looksLikeAccidentalName("bokchoy Integrated Webcam")).toBe(false);
    expect(looksLikeAccidentalName("Greenhouse North")).toBe(false);
  });
});

describe("findSuspiciousCaptureSources", () => {
  it("flags an empty source with an accidental numeric name", async () => {
    const source = await createSource({ name: "2" });

    const suspicious = await findSuspiciousCaptureSources(prisma);

    expect(suspicious.map((entry) => entry.source.id)).toContain(source.id);
    const found = suspicious.find((entry) => entry.source.id === source.id)!;
    expect(found.captureCount).toBe(0);
    expect(found.viewportCount).toBe(0);
    expect(found.reasons).toContain("unnamed");
  });

  it("does not flag a source with a real name and no recent-creation signal", async () => {
    const source = await createSource({
      name: "Bokchoy Front Camera",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const suspicious = await findSuspiciousCaptureSources(prisma);

    expect(suspicious.map((entry) => entry.source.id)).not.toContain(source.id);
  });

  it("does not flag a source that has real captures, even with an accidental-looking name", async () => {
    const source = await createSource({ name: "2" });
    await prisma.sourceCapture.create({
      data: {
        captureSourceId: source.id,
        timestamp: new Date(),
        originalPath: "/tmp/plantlab-test-source/capture.jpg",
        originalWidth: 1280,
        originalHeight: 720,
        workingWidth: 1280,
        workingHeight: 720,
        pixelFormat: "mjpeg",
      },
    });

    const suspicious = await findSuspiciousCaptureSources(prisma);

    expect(suspicious.map((entry) => entry.source.id)).not.toContain(source.id);
  });
});

describe("renameCaptureSource", () => {
  it("renames a source and rejects an empty name", async () => {
    const source = await createSource({ name: "2" });

    const renamed = await renameCaptureSource(prisma, source.id, "Bokchoy Front Camera");
    expect(renamed.name).toBe("Bokchoy Front Camera");

    await expect(renameCaptureSource(prisma, source.id, "   ")).rejects.toThrow(/empty/);
  });
});

describe("deleteEmptyCaptureSource", () => {
  it("deletes a source that has no captures or viewports", async () => {
    const source = await createSource({ name: "2" });

    await deleteEmptyCaptureSource(prisma, source.id);

    await expect(prisma.captureSource.findUniqueOrThrow({ where: { id: source.id } })).rejects.toThrow();
  });

  it("refuses to delete a source that has captures, and never deletes automatically", async () => {
    const source = await createSource({ name: "2" });
    await prisma.sourceCapture.create({
      data: {
        captureSourceId: source.id,
        timestamp: new Date(),
        originalPath: "/tmp/plantlab-test-source/capture.jpg",
        originalWidth: 1280,
        originalHeight: 720,
        workingWidth: 1280,
        workingHeight: 720,
        pixelFormat: "mjpeg",
      },
    });

    await expect(deleteEmptyCaptureSource(prisma, source.id)).rejects.toThrow(/Refusing to delete/);
    await expect(prisma.captureSource.findUniqueOrThrow({ where: { id: source.id } })).resolves.toBeTruthy();
  });

  it("detaches any linked node camera instead of leaving a dangling reference", async () => {
    const node = await prisma.plantLabNode.create({
      data: { name: "bokchoy", role: "camera-node" },
    });
    const source = await createSource({ name: "2" });
    const camera = await prisma.nodeCamera.create({
      data: {
        nodeId: node.id,
        stableId: "usb:1bcf:28c1",
        devicePath: "/dev/video1",
        captureSourceId: source.id,
      },
    });

    await deleteEmptyCaptureSource(prisma, source.id);

    const reloaded = await prisma.nodeCamera.findUniqueOrThrow({ where: { id: camera.id } });
    expect(reloaded.captureSourceId).toBeNull();
  });
});

describe("inspectCaptureSourceByIdOrName", () => {
  it("finds a source by id or by exact name", async () => {
    const source = await createSource({ name: "Greenhouse Zero Lookup Test" });

    const byId = await inspectCaptureSourceByIdOrName(prisma, source.id);
    expect(byId.source.id).toBe(source.id);

    const byName = await inspectCaptureSourceByIdOrName(prisma, "Greenhouse Zero Lookup Test");
    expect(byName.source.id).toBe(source.id);
  });

  it("throws a clear error when nothing matches", async () => {
    await expect(inspectCaptureSourceByIdOrName(prisma, "does-not-exist")).rejects.toThrow(/No capture source found/);
  });
});
