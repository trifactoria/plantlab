import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeVisualHistoryStatus,
  createCropVersionAndMaterialize,
  materializeCropsForNewPhoto,
  repairMissingCrops,
  resolveActiveCropVersion,
} from "../../src/lib/cropVersions";
import { CROP_PROVENANCE } from "../../src/lib/cropVersions";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

describe("cropVersions", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup() {
    const project = await createTestProject(prisma);
    const plant = await createTestPlant(prisma, project.id);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    return { project, plant };
  }

  async function photoAt(projectId: string, isoTimestamp: string) {
    const { photo, directory } = await createRealPhoto(prisma, projectId, {
      timestamp: new Date(isoTimestamp),
    });
    cleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));
    return photo;
  }

  it("resolveActiveCropVersion returns the newest version at or before the timestamp", async () => {
    const { project, plant } = await setup();
    const photoA = await photoAt(project.id, "2026-07-01T10:00:00.000Z");
    const photoB = await photoAt(project.id, "2026-07-10T10:00:00.000Z");

    const v1 = await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photoA.id,
      effectiveFrom: photoA.timestamp,
    });
    const v2 = await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.3, cropY: 0.3, cropWidth: 0.25, cropHeight: 0.25 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photoB.id,
      effectiveFrom: photoB.timestamp,
    });

    const beforeAny = await resolveActiveCropVersion(prisma, plant.id, new Date("2026-06-01T00:00:00.000Z"));
    expect(beforeAny).toBeNull();

    const betweenVersions = await resolveActiveCropVersion(prisma, plant.id, new Date("2026-07-05T00:00:00.000Z"));
    expect(betweenVersions?.id).toBe(v1.version.id);

    const afterSecond = await resolveActiveCropVersion(prisma, plant.id, new Date("2026-07-20T00:00:00.000Z"));
    expect(afterSecond?.id).toBe(v2.version.id);
  });

  it("first crop creates the initial version and materializes the source photo as INITIAL_VERSION", async () => {
    const { project, plant } = await setup();
    const photo = await photoAt(project.id, "2026-07-01T10:00:00.000Z");

    const result = await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "16:9",
      sourcePhotoId: photo.id,
      effectiveFrom: photo.timestamp,
    });

    expect(result.version.effectiveFrom.toISOString()).toBe(photo.timestamp.toISOString());
    const materialized = await prisma.plantPhotoCrop.findUniqueOrThrow({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo.id } },
    });
    expect(materialized.createdMethod).toBe(CROP_PROVENANCE.INITIAL_VERSION);
    expect(materialized.cropVersionId).toBe(result.version.id);
  });

  it("a project with an actual-first-photo initial crop naturally covers all earlier and later project photos", async () => {
    const { project, plant } = await setup();
    const first = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const later = await photoAt(project.id, "2026-07-02T08:00:00.000Z");

    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.2, cropY: 0.2, cropWidth: 0.3, cropHeight: 0.3 },
      aspectRatioMode: "1:1",
      sourcePhotoId: first.id,
      effectiveFrom: first.timestamp,
    });

    const laterCrop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: later.id } },
    });
    expect(laterCrop).not.toBeNull();
  });

  it("does not materialize photos before the selected effective frame", async () => {
    const { project, plant } = await setup();
    const earlier = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const selected = await photoAt(project.id, "2026-07-05T08:00:00.000Z");

    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "free",
      sourcePhotoId: selected.id,
      effectiveFrom: selected.timestamp,
    });

    const earlierCrop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: earlier.id } },
    });
    expect(earlierCrop).toBeNull();
  });

  it("adjusting from a later frame does not change earlier materialized crops", async () => {
    const { project, plant } = await setup();
    const photo1 = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const photo2 = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
    const photo3 = await photoAt(project.id, "2026-07-03T08:00:00.000Z");

    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photo1.id,
      effectiveFrom: photo1.timestamp,
    });

    const photo1CropBefore = await prisma.plantPhotoCrop.findUniqueOrThrow({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo1.id } },
    });

    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.4, cropY: 0.4, cropWidth: 0.3, cropHeight: 0.3 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photo2.id,
      effectiveFrom: photo2.timestamp,
    });

    const photo1CropAfter = await prisma.plantPhotoCrop.findUniqueOrThrow({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo1.id } },
    });
    expect(photo1CropAfter).toEqual(photo1CropBefore);

    const photo3Crop = await prisma.plantPhotoCrop.findUniqueOrThrow({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo3.id } },
    });
    expect(photo3Crop.cropX).toBe(0.4);
  });

  it("a still-later crop version remains a separate boundary and is not silently erased", async () => {
    const { project, plant } = await setup();
    const photo1 = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const photo2 = await photoAt(project.id, "2026-07-10T08:00:00.000Z");
    const between = await photoAt(project.id, "2026-07-05T08:00:00.000Z");

    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photo1.id,
      effectiveFrom: photo1.timestamp,
    });

    // A version further in the future already exists.
    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.5, cropY: 0.5, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photo2.id,
      effectiveFrom: photo2.timestamp,
    });

    // Now adjust starting from a frame BETWEEN the two - it must only govern
    // the window up to photo2's version, never past it.
    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.3, cropY: 0.3, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: between.id,
      effectiveFrom: between.timestamp,
    });

    const versions = await prisma.plantCropVersion.findMany({
      where: { plantId: plant.id },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(versions).toHaveLength(3);

    const photo2Crop = await prisma.plantPhotoCrop.findUniqueOrThrow({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo2.id } },
    });
    expect(photo2Crop.cropX).toBe(0.5); // untouched by the middle adjustment
  });

  it("preserves a manually adjusted crop when adjusting from an earlier frame, except the exact source photo", async () => {
    const { project, plant } = await setup();
    const photo1 = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const manualPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");

    await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photo1.id,
      effectiveFrom: photo1.timestamp,
    });

    // User manually hand-adjusts this one exact frame via the plain crop editor.
    await prisma.plantPhotoCrop.update({
      where: { plantId_photoId: { plantId: plant.id, photoId: manualPhoto.id } },
      data: { cropX: 0.9, cropY: 0.9, createdMethod: "manual" },
    });

    // Re-adjust from photo1 forward again.
    const result = await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.15, cropY: 0.15, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "1:1",
      sourcePhotoId: photo1.id,
      effectiveFrom: photo1.timestamp,
    });

    expect(result.preservedManualCount).toBe(1);
    const manualCrop = await prisma.plantPhotoCrop.findUniqueOrThrow({
      where: { plantId_photoId: { plantId: plant.id, photoId: manualPhoto.id } },
    });
    expect(manualCrop.cropX).toBe(0.9);
  });

  it("preserves the selected aspect ratio unless explicitly changed", async () => {
    const { project, plant } = await setup();
    const photo = await photoAt(project.id, "2026-07-01T08:00:00.000Z");

    const result = await createCropVersionAndMaterialize(prisma, {
      plantId: plant.id,
      projectId: project.id,
      crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
      aspectRatioMode: "9:16",
      sourcePhotoId: photo.id,
      effectiveFrom: photo.timestamp,
    });
    expect(result.version.id).toBeTruthy();

    const stored = await prisma.plantCropVersion.findUniqueOrThrow({ where: { id: result.version.id } });
    expect(stored.aspectRatioMode).toBe("9:16");
  });

  describe("materializeCropsForNewPhoto", () => {
    it("materializes crops from active versions for multiple plants independently", async () => {
      const { project, plant: plantA } = await setup();
      const plantB = await createTestPlant(prisma, project.id, { gridX: 1, gridY: 0 });

      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      await createCropVersionAndMaterialize(prisma, {
        plantId: plantA.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await createCropVersionAndMaterialize(prisma, {
        plantId: plantB.id,
        projectId: project.id,
        crop: { cropX: 0.6, cropY: 0.6, cropWidth: 0.15, cropHeight: 0.15 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      const newPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      const materialized = await materializeCropsForNewPhoto(prisma, newPhoto);
      expect(materialized).toHaveLength(2);

      const cropA = await prisma.plantPhotoCrop.findUniqueOrThrow({
        where: { plantId_photoId: { plantId: plantA.id, photoId: newPhoto.id } },
      });
      const cropB = await prisma.plantPhotoCrop.findUniqueOrThrow({
        where: { plantId_photoId: { plantId: plantB.id, photoId: newPhoto.id } },
      });
      expect(cropA.cropX).toBe(0.1);
      expect(cropB.cropX).toBe(0.6);
      expect(cropA.createdMethod).toBe(CROP_PROVENANCE.ACTIVE_VERSION);
    });

    it("is idempotent under retries - never creates duplicate rows", async () => {
      const { project, plant } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      const newPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      await materializeCropsForNewPhoto(prisma, newPhoto);
      await materializeCropsForNewPhoto(prisma, newPhoto);
      await materializeCropsForNewPhoto(prisma, newPhoto);

      const count = await prisma.plantPhotoCrop.count({ where: { plantId: plant.id, photoId: newPhoto.id } });
      expect(count).toBe(1);
    });

    it("never overwrites an existing manual crop for the new photo", async () => {
      const { project, plant } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      const newPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      await prisma.plantPhotoCrop.create({
        data: {
          plantId: plant.id,
          photoId: newPhoto.id,
          cropX: 0.99,
          cropY: 0.99,
          cropWidth: 0.01,
          cropHeight: 0.01,
          createdMethod: "manual",
        },
      });

      await materializeCropsForNewPhoto(prisma, newPhoto);

      const crop = await prisma.plantPhotoCrop.findUniqueOrThrow({
        where: { plantId_photoId: { plantId: plant.id, photoId: newPhoto.id } },
      });
      expect(crop.cropX).toBe(0.99);
      expect(crop.createdMethod).toBe("manual");
    });

    it("does not create crops when automatic assignment is disabled", async () => {
      const { project, plant } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plant.update({ where: { id: plant.id }, data: { automaticCropAssignmentEnabled: false } });

      const newPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      const materialized = await materializeCropsForNewPhoto(prisma, newPhoto);
      expect(materialized).toHaveLength(0);

      const crop = await prisma.plantPhotoCrop.findUnique({
        where: { plantId_photoId: { plantId: plant.id, photoId: newPhoto.id } },
      });
      expect(crop).toBeNull();
    });

    it("never applies crops or versions from another project", async () => {
      const { plant } = await setup();
      const otherProject = await createTestProject(prisma);
      cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));

      const seedPhoto = await photoAt(plant.projectId, "2026-07-01T08:00:00.000Z");
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: plant.projectId,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      const foreignPhoto = await photoAt(otherProject.id, "2026-07-02T08:00:00.000Z");
      const materialized = await materializeCropsForNewPhoto(prisma, foreignPhoto);
      expect(materialized).toHaveLength(0);
    });
  });

  describe("repairMissingCrops", () => {
    it("creates only missing crops and never invents one before the first version", async () => {
      const { project, plant } = await setup();
      const beforeFirstVersion = await photoAt(project.id, "2026-06-25T08:00:00.000Z");
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");

      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      // Simulate a photo created while auto-assignment happened to miss it.
      await prisma.plantPhotoCrop.deleteMany({ where: { plantId: plant.id, photoId: missingPhoto.id } });

      const result = await repairMissingCrops(prisma, plant.id);
      expect(result.added).toBe(1);
      expect(result.skippedExisting).toBe(1); // seedPhoto already had one

      const beforeVersionCrop = await prisma.plantPhotoCrop.findUnique({
        where: { plantId_photoId: { plantId: plant.id, photoId: beforeFirstVersion.id } },
      });
      expect(beforeVersionCrop).toBeNull();
    });

    it("preserves manual crops and reports them separately", async () => {
      const { project, plant } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const manualPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");

      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plantPhotoCrop.update({
        where: { plantId_photoId: { plantId: plant.id, photoId: manualPhoto.id } },
        data: { cropX: 0.77, createdMethod: "manual" },
      });

      const result = await repairMissingCrops(prisma, plant.id);
      expect(result.added).toBe(0);
      expect(result.preservedManual).toBe(1);

      const manualCrop = await prisma.plantPhotoCrop.findUniqueOrThrow({
        where: { plantId_photoId: { plantId: plant.id, photoId: manualPhoto.id } },
      });
      expect(manualCrop.cropX).toBe(0.77);
    });

    it("is idempotent - running twice adds nothing the second time", async () => {
      const { project, plant } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");

      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plantPhotoCrop.deleteMany({ where: { plantId: plant.id, photoId: missingPhoto.id } });

      const first = await repairMissingCrops(prisma, plant.id);
      expect(first.added).toBe(1);

      const second = await repairMissingCrops(prisma, plant.id);
      expect(second.added).toBe(0);
      expect(second.skippedExisting).toBe(2);

      const count = await prisma.plantPhotoCrop.count({ where: { plantId: plant.id } });
      expect(count).toBe(2);
    });
  });

  describe("computeVisualHistoryStatus", () => {
    it("reports totals, missing count, automatic-assignment status, and version count", async () => {
      const { project, plant } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");

      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      // Created after the version exists, via the plain test fixture (not
      // materializeCropsForNewPhoto), so it's genuinely missing a crop -
      // simulating a photo that fell through automatic assignment.
      await photoAt(project.id, "2026-07-02T08:00:00.000Z");

      const status = await computeVisualHistoryStatus(prisma, plant.id);
      expect(status.totalApplicablePhotos).toBe(2);
      expect(status.materializedCount).toBe(1);
      expect(status.missingCount).toBe(1);
      expect(status.automaticCropAssignmentEnabled).toBe(true);
      expect(status.versionCount).toBe(1);
    });

    it("plants without any crop version report zero missing, using legacy materialized crops as the total", async () => {
      const { project, plant } = await setup();
      const legacyPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      await prisma.plantPhotoCrop.create({
        data: {
          plantId: plant.id,
          photoId: legacyPhoto.id,
          cropX: 0.1,
          cropY: 0.1,
          cropWidth: 0.2,
          cropHeight: 0.2,
          createdMethod: "manual",
        },
      });

      const status = await computeVisualHistoryStatus(prisma, plant.id);
      expect(status.versionCount).toBe(0);
      expect(status.missingCount).toBe(0);
      expect(status.materializedCount).toBe(1);
    });
  });
});
