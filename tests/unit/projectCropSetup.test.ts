import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeProjectCropStatus,
  createCropVersionAndMaterialize,
  loadProjectCropSetupData,
  repairMissingCrops,
  repairProjectMissingCrops,
} from "../../src/lib/cropVersions";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

describe("project crop setup services", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup() {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    return { project };
  }

  async function photoAt(projectId: string, isoTimestamp: string) {
    const { photo, directory } = await createRealPhoto(prisma, projectId, {
      timestamp: new Date(isoTimestamp),
    });
    cleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));
    return photo;
  }

  describe("computeProjectCropStatus", () => {
    it("returns plants in grid order (gridY then gridX) and classifies each state", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");

      const bottomLeft = await createTestPlant(prisma, project.id, { name: "R1", gridX: 0, gridY: 1 });
      const topRight = await createTestPlant(prisma, project.id, { name: "R2", gridX: 1, gridY: 0 });
      const topLeft = await createTestPlant(prisma, project.id, { name: "R3", gridX: 0, gridY: 0 });

      // topLeft: configured (has a version). topRight: legacy only. bottomLeft: unconfigured.
      await createCropVersionAndMaterialize(prisma, {
        plantId: topLeft.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plantPhotoCrop.create({
        data: {
          plantId: topRight.id,
          photoId: seedPhoto.id,
          cropX: 0.3,
          cropY: 0.3,
          cropWidth: 0.1,
          cropHeight: 0.1,
          createdMethod: "manual",
        },
      });

      const status = await computeProjectCropStatus(prisma, project.id);

      expect(status.plants.map((plant) => plant.id)).toEqual([topLeft.id, topRight.id, bottomLeft.id]);
      expect(status.plants[0].state).toBe("configured");
      expect(status.plants[1].state).toBe("legacy");
      expect(status.plants[2].state).toBe("unconfigured");
      expect(status.totalPlants).toBe(3);
      expect(status.configuredCount).toBe(1);
      expect(status.legacyOnlyCount).toBe(1);
      expect(status.unconfiguredCount).toBe(1);
    });

    it("reports automatic-assignment-disabled plants separately", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const plant = await createTestPlant(prisma, project.id);
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plant.update({ where: { id: plant.id }, data: { automaticCropAssignmentEnabled: false } });

      const status = await computeProjectCropStatus(prisma, project.id);
      expect(status.automaticAssignmentDisabledCount).toBe(1);
    });

    it("never includes plants from another project", async () => {
      const { project } = await setup();
      const otherProject = await createTestProject(prisma);
      cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));
      await createTestPlant(prisma, otherProject.id, { name: "Foreign" });
      await createTestPlant(prisma, project.id, { name: "Local" });

      const status = await computeProjectCropStatus(prisma, project.id);
      expect(status.plants).toHaveLength(1);
      expect(status.plants[0].name).toBe("Local");
    });
  });

  describe("loadProjectCropSetupData", () => {
    it("defaults to the latest project photo when none is requested", async () => {
      const { project } = await setup();
      await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const latest = await photoAt(project.id, "2026-07-05T08:00:00.000Z");

      const data = await loadProjectCropSetupData(prisma, project.id, null);
      expect(data?.photo.id).toBe(latest.id);
    });

    it("returns null for a photoId that does not belong to the project", async () => {
      const { project } = await setup();
      const otherProject = await createTestProject(prisma);
      cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));
      const foreignPhoto = await photoAt(otherProject.id, "2026-07-01T08:00:00.000Z");

      const data = await loadProjectCropSetupData(prisma, project.id, foreignPhoto.id);
      expect(data).toBeNull();
    });

    it("resolves cropSource per plant: legacy_row, existing_crop_row, active_version, none", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");

      const legacyPlant = await createTestPlant(prisma, project.id, { gridX: 0, gridY: 0 });
      await prisma.plantPhotoCrop.create({
        data: {
          plantId: legacyPlant.id,
          photoId: seedPhoto.id,
          cropX: 0.2,
          cropY: 0.2,
          cropWidth: 0.1,
          cropHeight: 0.1,
          createdMethod: "manual",
        },
      });

      const configuredPlant = await createTestPlant(prisma, project.id, { gridX: 1, gridY: 0 });
      await createCropVersionAndMaterialize(prisma, {
        plantId: configuredPlant.id,
        projectId: project.id,
        crop: { cropX: 0.3, cropY: 0.3, cropWidth: 0.1, cropHeight: 0.1 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      const unconfiguredPlant = await createTestPlant(prisma, project.id, { gridX: 2, gridY: 0 });

      // Created AFTER the version, so createCropVersionAndMaterialize never
      // touched it - its crop only resolves dynamically (active_version).
      const laterPhoto = await photoAt(project.id, "2026-07-05T08:00:00.000Z");

      // On the SEED photo: legacy has an exact row (legacy_row), configured
      // has an exact row too (its own materialized/initial crop -> existing_crop_row).
      const onSeed = await loadProjectCropSetupData(prisma, project.id, seedPhoto.id);
      const legacyOnSeed = onSeed?.plants.find((plant) => plant.id === legacyPlant.id);
      const configuredOnSeed = onSeed?.plants.find((plant) => plant.id === configuredPlant.id);
      const unconfiguredOnSeed = onSeed?.plants.find((plant) => plant.id === unconfiguredPlant.id);
      expect(legacyOnSeed?.cropSource).toBe("legacy_row");
      expect(configuredOnSeed?.cropSource).toBe("existing_crop_row");
      expect(unconfiguredOnSeed?.cropSource).toBe("none");
      expect(unconfiguredOnSeed?.crop).toBeNull();

      // On the LATER photo: configured has no exact row yet, but its
      // version applies (active_version). Legacy still has nothing there.
      const onLater = await loadProjectCropSetupData(prisma, project.id, laterPhoto.id);
      const configuredOnLater = onLater?.plants.find((plant) => plant.id === configuredPlant.id);
      const legacyOnLater = onLater?.plants.find((plant) => plant.id === legacyPlant.id);
      expect(configuredOnLater?.cropSource).toBe("active_version");
      expect(configuredOnLater?.crop?.cropX).toBe(0.3);
      expect(legacyOnLater?.cropSource).toBe("none");
    });
  });

  describe("repairProjectMissingCrops", () => {
    it("repairs all configured plants and reports unconfigured/disabled plants separately", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");

      const configuredA = await createTestPlant(prisma, project.id, { gridX: 0, gridY: 0 });
      const configuredB = await createTestPlant(prisma, project.id, { gridX: 1, gridY: 0 });
      const disabled = await createTestPlant(prisma, project.id, { gridX: 2, gridY: 0 });
      const unconfigured = await createTestPlant(prisma, project.id, { gridX: 3, gridY: 0 });

      for (const plant of [configuredA, configuredB, disabled]) {
        await createCropVersionAndMaterialize(prisma, {
          plantId: plant.id,
          projectId: project.id,
          crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
          aspectRatioMode: "1:1",
          sourcePhotoId: seedPhoto.id,
          effectiveFrom: seedPhoto.timestamp,
        });
      }
      await prisma.plant.update({ where: { id: disabled.id }, data: { automaticCropAssignmentEnabled: false } });

      // Simulate frames that fell through automatic assignment.
      await prisma.plantPhotoCrop.deleteMany({ where: { photoId: missingPhoto.id } });

      const report = await repairProjectMissingCrops(prisma, project.id);

      expect(report.totalPlants).toBe(4);
      expect(report.configuredCount).toBe(3);
      expect(report.unconfiguredCount).toBe(1);
      expect(report.automaticAssignmentDisabledCount).toBe(1);
      expect(report.added).toBe(2); // configuredA + configuredB on missingPhoto, not disabled
      expect(report.perPlant.map((entry) => entry.plantId).sort()).toEqual(
        [configuredA.id, configuredB.id].sort(),
      );

      const unconfiguredCrop = await prisma.plantPhotoCrop.findUnique({
        where: { plantId_photoId: { plantId: unconfigured.id, photoId: missingPhoto.id } },
      });
      expect(unconfiguredCrop).toBeNull();

      const disabledCrop = await prisma.plantPhotoCrop.findUnique({
        where: { plantId_photoId: { plantId: disabled.id, photoId: missingPhoto.id } },
      });
      expect(disabledCrop).toBeNull();
    });

    it("produces the same per-plant result as calling repairMissingCrops directly (shared service parity)", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      const plant = await createTestPlant(prisma, project.id);
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plantPhotoCrop.deleteMany({ where: { photoId: missingPhoto.id } });

      const projectReport = await repairProjectMissingCrops(prisma, project.id);
      const perPlantResult = projectReport.perPlant.find((entry) => entry.plantId === plant.id);

      // Re-run per-plant repair directly - idempotent, should now report 0 added.
      const directRepeat = await repairMissingCrops(prisma, plant.id);

      expect(perPlantResult?.result.added).toBe(1);
      expect(directRepeat.added).toBe(0);
      expect(directRepeat.skippedExisting).toBe(2);
    });

    it("does not modify photos before a plant's first crop version", async () => {
      const { project } = await setup();
      const beforeFirst = await photoAt(project.id, "2026-06-25T08:00:00.000Z");
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const plant = await createTestPlant(prisma, project.id);
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      await repairProjectMissingCrops(prisma, project.id);

      const beforeCrop = await prisma.plantPhotoCrop.findUnique({
        where: { plantId_photoId: { plantId: plant.id, photoId: beforeFirst.id } },
      });
      expect(beforeCrop).toBeNull();
    });

    it("preserves manual crops during project-wide sync", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const manualPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      const plant = await createTestPlant(prisma, project.id);
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
        data: { cropX: 0.88, createdMethod: "manual" },
      });

      const report = await repairProjectMissingCrops(prisma, project.id);
      expect(report.preservedManual).toBe(1);

      const manualCrop = await prisma.plantPhotoCrop.findUniqueOrThrow({
        where: { plantId_photoId: { plantId: plant.id, photoId: manualPhoto.id } },
      });
      expect(manualCrop.cropX).toBe(0.88);
    });

    it("is idempotent - running twice adds nothing the second time", async () => {
      const { project } = await setup();
      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
      const plant = await createTestPlant(prisma, project.id);
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });
      await prisma.plantPhotoCrop.deleteMany({ where: { photoId: missingPhoto.id } });

      const first = await repairProjectMissingCrops(prisma, project.id);
      expect(first.added).toBe(1);

      const second = await repairProjectMissingCrops(prisma, project.id);
      expect(second.added).toBe(0);

      const count = await prisma.plantPhotoCrop.count({ where: { plantId: plant.id } });
      expect(count).toBe(2);
    });

    it("keeps projects fully isolated", async () => {
      const { project } = await setup();
      const otherProject = await createTestProject(prisma);
      cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));

      const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
      const plant = await createTestPlant(prisma, project.id);
      await createCropVersionAndMaterialize(prisma, {
        plantId: plant.id,
        projectId: project.id,
        crop: { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 },
        aspectRatioMode: "1:1",
        sourcePhotoId: seedPhoto.id,
        effectiveFrom: seedPhoto.timestamp,
      });

      const otherPlant = await createTestPlant(prisma, otherProject.id);

      const report = await repairProjectMissingCrops(prisma, project.id);
      expect(report.perPlant.every((entry) => entry.plantId !== otherPlant.id)).toBe(true);
      expect(report.totalPlants).toBe(1);
    });
  });
});
