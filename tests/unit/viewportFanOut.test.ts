import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { prisma } from "../../src/lib/prisma";
import { resolveActiveViewportsForSource, runViewportFanOut } from "../../src/lib/viewportFanOut";
import { cleanupTestCaptureSource, createRealSourceCapture, createTestCaptureSource } from "./helpers/testCaptureSource";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

describe("viewportFanOut", () => {
  const sources: Array<{ id: string; directory: string }> = [];
  const projects: Array<{ id: string; directory: string }> = [];
  const extraDirectories: string[] = [];

  afterEach(async () => {
    for (const { id, directory } of sources.splice(0)) {
      await cleanupTestCaptureSource(prisma, id, directory);
    }
    for (const { id, directory } of projects.splice(0)) {
      await cleanupTestProject(prisma, id, directory);
    }
    for (const directory of extraDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeSource(overrides: Parameters<typeof createTestCaptureSource>[1] = {}) {
    const source = await createTestCaptureSource(prisma, { width: 200, height: 100, rotation: 0, ...overrides });
    sources.push({ id: source.id, directory: source.captureDirectory });
    return source;
  }

  async function makeProject(overrides: Parameters<typeof createTestProject>[1] = {}) {
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null, ...overrides });
    projects.push({ id: project.id, directory: project.localPhotoDirectory });
    return project;
  }

  it("resolves the newest active viewport per project, mirroring plant crop version resolution", async () => {
    const source = await makeSource();
    const project = await makeProject();
    const timestamp = new Date("2026-07-11T12:00:00.000Z");

    const early = await prisma.projectViewport.create({
      data: { projectId: project.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 1, effectiveFrom: new Date("2026-07-01T00:00:00Z"), active: true },
    });
    const later = await prisma.projectViewport.create({
      data: { projectId: project.id, captureSourceId: source.id, cropX: 0.5, cropY: 0, cropWidth: 0.5, cropHeight: 1, effectiveFrom: new Date("2026-07-10T00:00:00Z"), active: true },
    });
    await prisma.projectViewport.create({
      data: { projectId: project.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1, effectiveFrom: new Date("2026-07-20T00:00:00Z"), active: true },
    });

    const resolved = await resolveActiveViewportsForSource(prisma, source.id, timestamp);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(later.id);
    expect(resolved[0].id).not.toBe(early.id);
  });

  it("ignores inactive (deactivated) viewports", async () => {
    const source = await makeSource();
    const project = await makeProject();

    await prisma.projectViewport.create({
      data: { projectId: project.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1, effectiveFrom: new Date("2026-07-01T00:00:00Z"), active: false },
    });

    const resolved = await resolveActiveViewportsForSource(prisma, source.id, new Date("2026-07-11T00:00:00Z"));
    expect(resolved).toHaveLength(0);
  });

  it("fans out one source capture into one derived, correctly-cropped photo per project, source captured once", async () => {
    const source = await makeSource();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const timestamp = new Date("2026-07-11T15:00:00.000Z");

    const { sourceCapture, directory } = await createRealSourceCapture(prisma, source.id, { timestamp });
    extraDirectories.push(directory);

    // Left half (red top / blue bottom) -> projectA. Right half (green top / yellow bottom) -> projectB.
    await prisma.projectViewport.create({
      data: { projectId: projectA.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 1, effectiveFrom: timestamp, active: true },
    });
    await prisma.projectViewport.create({
      data: { projectId: projectB.id, captureSourceId: source.id, cropX: 0.5, cropY: 0, cropWidth: 0.5, cropHeight: 1, effectiveFrom: timestamp, active: true },
    });

    const result = await runViewportFanOut(sourceCapture.id);

    expect(result.projectResults).toHaveLength(2);
    expect(result.projectResults.every((r) => r.status === "success")).toBe(true);
    expect(await prisma.sourceCapture.count({ where: { captureSourceId: source.id } })).toBe(1);

    const photoA = await prisma.photo.findFirst({ where: { projectId: projectA.id } });
    const photoB = await prisma.photo.findFirst({ where: { projectId: projectB.id } });
    expect(photoA).toBeTruthy();
    expect(photoB).toBeTruthy();
    expect(photoA?.sourceCaptureId).toBe(sourceCapture.id);
    expect(photoB?.sourceCaptureId).toBe(sourceCapture.id);
    // Preserves the source capture's timestamp, not "now".
    expect(photoA?.timestamp.toISOString()).toBe(timestamp.toISOString());
    expect(photoB?.timestamp.toISOString()).toBe(timestamp.toISOString());

    const bufferA = await readFile(photoA!.path);
    const metaA = await sharp(bufferA).metadata();
    expect(metaA.width).toBe(100);
    expect(metaA.height).toBe(100);

    // ProjectA's derived crop should be red-over-blue (left half).
    const { data: rawA, info } = await sharp(bufferA).raw().toBuffer({ resolveWithObject: true });
    const topA = rawA.subarray(0, 3);
    const bottomOffset = (info.height - 1) * info.width * info.channels;
    const bottomA = rawA.subarray(bottomOffset, bottomOffset + 3);
    expect(topA[0]).toBeGreaterThan(200); // red channel high at top
    expect(bottomA[2]).toBeGreaterThan(200); // blue channel high at bottom
  });

  it("isolates a per-project failure - one project failing does not affect or falsely mark siblings", async () => {
    const source = await makeSource();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const timestamp = new Date("2026-07-11T16:00:00.000Z");

    const { sourceCapture, directory } = await createRealSourceCapture(prisma, source.id, { timestamp });
    extraDirectories.push(directory);

    await prisma.projectViewport.create({
      data: { projectId: projectA.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 1, effectiveFrom: timestamp, active: true },
    });
    await prisma.projectViewport.create({
      data: { projectId: projectB.id, captureSourceId: source.id, cropX: 0.5, cropY: 0, cropWidth: 0.5, cropHeight: 1, effectiveFrom: timestamp, active: true },
    });

    // Sabotage projectB's photo directory: a plain file exists where a
    // directory is expected, so mkdir(recursive) for it throws.
    await rm(projectB.localPhotoDirectory, { recursive: true, force: true }).catch(() => undefined);
    await writeFile(projectB.localPhotoDirectory, "not a directory");

    const result = await runViewportFanOut(sourceCapture.id);

    const resultA = result.projectResults.find((r) => r.projectId === projectA.id);
    const resultB = result.projectResults.find((r) => r.projectId === projectB.id);

    expect(resultA?.status).toBe("success");
    expect(resultB?.status).toBe("failed");
    expect(resultB?.errorMessage).toBeTruthy();

    const photoA = await prisma.photo.findFirst({ where: { projectId: projectA.id } });
    const photoB = await prisma.photo.findFirst({ where: { projectId: projectB.id } });
    expect(photoA).toBeTruthy();
    expect(photoB).toBeNull();

    // Cleanup the sabotage path manually since it's a file, not the directory helper expects.
    await rm(projectB.localPhotoDirectory, { force: true }).catch(() => undefined);
  });

  it("applies rotation before viewport geometry - a viewport drawn against the working frame stays correct", async () => {
    // Raw capture is 100x200; rotated 90 degrees clockwise, the working
    // frame is 200x100 (matches the non-rotated fan-out test's viewport
    // math), and a viewport over the left half of the working frame should
    // land on the pixels that were the top edge of the raw capture.
    const source = await makeSource({ width: 200, height: 100, rotation: 90 });
    const project = await makeProject();
    const timestamp = new Date("2026-07-11T17:00:00.000Z");

    const { sourceCapture, directory } = await createRealSourceCapture(prisma, source.id, {
      timestamp,
      rawWidth: 100,
      rawHeight: 200,
    });
    extraDirectories.push(directory);

    await prisma.projectViewport.create({
      data: { projectId: project.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1, effectiveFrom: timestamp, active: true },
    });

    const result = await runViewportFanOut(sourceCapture.id);
    expect(result.projectResults[0].status).toBe("success");
    expect(result.projectResults[0].derivedWidth).toBe(200);
    expect(result.projectResults[0].derivedHeight).toBe(100);

    const photo = await prisma.photo.findFirst({ where: { projectId: project.id } });
    const buffer = await readFile(photo!.path);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(100);
  });

  it("materializes plant crops onto the derived photo through the shared photo-ingest pipeline", async () => {
    const { createTestPlant, createRealPhoto } = await import("./helpers/testPlantPhoto");
    const { createCropVersionAndMaterialize } = await import("../../src/lib/cropVersions");

    const source = await makeSource();
    const project = await makeProject();
    const timestamp = new Date("2026-07-11T18:00:00.000Z");

    await prisma.projectViewport.create({
      data: { projectId: project.id, captureSourceId: source.id, cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1, effectiveFrom: new Date("2026-07-01T00:00:00Z"), active: true },
    });

    const plant = await createTestPlant(prisma, project.id);
    const { photo: seedPhoto, directory: seedPhotoDirectory } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-01T00:00:00Z"),
    });
    extraDirectories.push(seedPhotoDirectory);
    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "free",
      sourcePhotoId: seedPhoto.id,
      effectiveFrom: new Date("2026-07-01T00:00:00Z"),
    });

    const { sourceCapture, directory } = await createRealSourceCapture(prisma, source.id, { timestamp });
    extraDirectories.push(directory);

    await runViewportFanOut(sourceCapture.id);

    // This project now has two photos - the seed photo used to establish
    // the crop version, and the one just derived by fan-out. findFirst()
    // with no orderBy has no guaranteed row order (SQLite/Prisma make no
    // ordering promise without one), so explicitly pick the fan-out's
    // derived photo by its known timestamp rather than relying on
    // whichever row the query planner happens to return first.
    const photo = await prisma.photo.findFirst({ where: { projectId: project.id, timestamp } });
    const crop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo!.id } },
    });
    expect(crop).not.toBeNull();
    expect(crop?.createdMethod).toBe("active_version");
  });
});
