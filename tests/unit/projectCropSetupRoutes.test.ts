import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { GET as getCropSetup } from "../../src/app/api/projects/[projectId]/crop-setup/route";
import { GET as getCropStatus } from "../../src/app/api/projects/[projectId]/crop-status/route";
import { POST as postSync } from "../../src/app/api/projects/[projectId]/visual-history/sync/route";
import { POST as postCropVersion } from "../../src/app/api/plants/[plantId]/crop-versions/route";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("project crop setup routes", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup() {
    const project = await createTestProject(prisma);
    cleanup.push(() =>
      cleanupTestProject(prisma, project.id, project.localPhotoDirectory),
    );
    return { project };
  }

  async function photoAt(projectId: string, isoTimestamp: string) {
    const { photo, directory } = await createRealPhoto(prisma, projectId, {
      timestamp: new Date(isoTimestamp),
    });
    cleanup.push(() =>
      rm(directory, { recursive: true, force: true }).catch(() => undefined),
    );
    return photo;
  }

  it("GET crop-status returns 404 for an unknown project", async () => {
    const response = await getCropStatus(
      new Request("http://localhost"),
      context("does-not-exist"),
    );
    expect(response.status).toBe(404);
  });

  it("GET crop-status reports plant counts for a real project", async () => {
    const { project } = await setup();
    const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const plant = await createTestPlant(prisma, project.id);
    await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: seedPhoto.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );

    const response = await getCropStatus(
      new Request("http://localhost"),
      context(project.id),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.totalPlants).toBe(1);
    expect(payload.configuredCount).toBe(1);
  });

  it("GET crop-setup returns 400 for a photoId from a different project", async () => {
    const { project } = await setup();
    const otherProject = await createTestProject(prisma);
    cleanup.push(() =>
      cleanupTestProject(
        prisma,
        otherProject.id,
        otherProject.localPhotoDirectory,
      ),
    );
    const foreignPhoto = await photoAt(
      otherProject.id,
      "2026-07-01T08:00:00.000Z",
    );

    const response = await getCropSetup(
      new Request(
        `http://localhost/api/projects/${project.id}/crop-setup?photoId=${foreignPhoto.id}`,
      ),
      context(project.id),
    );
    expect(response.status).toBe(400);
  });

  it("GET crop-setup defaults to the latest photo and lists plants in grid order", async () => {
    const { project } = await setup();
    await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const latest = await photoAt(project.id, "2026-07-05T08:00:00.000Z");
    await createTestPlant(prisma, project.id, {
      name: "Second",
      gridX: 1,
      gridY: 0,
    });
    await createTestPlant(prisma, project.id, {
      name: "First",
      gridX: 0,
      gridY: 0,
    });

    const response = await getCropSetup(
      new Request(`http://localhost/api/projects/${project.id}/crop-setup`),
      context(project.id),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.photo.id).toBe(latest.id);
    expect(payload.plants.map((plant: { name: string }) => plant.name)).toEqual(
      ["First", "Second"],
    );
  });

  it("POST visual-history/sync reports and applies project-wide repair", async () => {
    const { project } = await setup();
    const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
    const plant = await createTestPlant(prisma, project.id);
    await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: seedPhoto.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );
    await prisma.plantPhotoCrop.deleteMany({
      where: { photoId: missingPhoto.id },
    });

    const response = await postSync(
      new Request("http://localhost", { method: "POST" }),
      context(project.id),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.added).toBe(1);

    const crop = await prisma.plantPhotoCrop.findUnique({
      where: {
        plantId_photoId: { plantId: plant.id, photoId: missingPhoto.id },
      },
    });
    expect(crop).not.toBeNull();
  });

  it("POST visual-history/sync is idempotent across repeated calls", async () => {
    const { project } = await setup();
    const seedPhoto = await photoAt(project.id, "2026-07-01T08:00:00.000Z");
    const missingPhoto = await photoAt(project.id, "2026-07-02T08:00:00.000Z");
    const plant = await createTestPlant(prisma, project.id);
    await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: seedPhoto.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );
    await prisma.plantPhotoCrop.deleteMany({
      where: { photoId: missingPhoto.id },
    });

    await postSync(
      new Request("http://localhost", { method: "POST" }),
      context(project.id),
    );
    const second = await postSync(
      new Request("http://localhost", { method: "POST" }),
      context(project.id),
    );
    const payload = await second.json();
    expect(payload.added).toBe(0);
  });
});
