import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { GET as getCropVersions, POST as postCropVersion } from "../../src/app/api/plants/[plantId]/crop-versions/route";
import { POST as postRepair } from "../../src/app/api/plants/[plantId]/visual-history/repair/route";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("crop-version routes", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  it("rejects a source photo from a different project", async () => {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    const plant = await createTestPlant(prisma, project.id);

    const otherProject = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));
    const { photo: foreignPhoto, directory } = await createRealPhoto(prisma, otherProject.id);
    cleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));

    const response = await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: foreignPhoto.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );
    expect(response.status).toBe(400);

    const versions = await prisma.plantCropVersion.count({ where: { plantId: plant.id } });
    expect(versions).toBe(0);
  });

  it("rejects an invalid aspect ratio mode", async () => {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    const plant = await createTestPlant(prisma, project.id);
    const { photo, directory } = await createRealPhoto(prisma, project.id);
    cleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));

    const response = await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "21:9",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );
    expect(response.status).toBe(400);
  });

  it("lists versions oldest first for inspection", async () => {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    const plant = await createTestPlant(prisma, project.id);
    const { photo: photo1, directory: dir1 } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-01T08:00:00.000Z"),
    });
    const { photo: photo2, directory: dir2 } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-05T08:00:00.000Z"),
    });
    cleanup.push(() => rm(dir1, { recursive: true, force: true }).catch(() => undefined));
    cleanup.push(() => rm(dir2, { recursive: true, force: true }).catch(() => undefined));

    await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: photo2.id,
        cropX: 0.4,
        cropY: 0.4,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );
    await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: photo1.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );

    const response = await getCropVersions(new Request("http://localhost"), {
      params: Promise.resolve({ plantId: plant.id }),
    });
    const payload = await response.json();
    expect(payload.versions).toHaveLength(2);
    expect(new Date(payload.versions[0].effectiveFrom).getTime()).toBeLessThan(
      new Date(payload.versions[1].effectiveFrom).getTime(),
    );
  });

  it("repair reports accurate counts including plants with no crop version yet", async () => {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    const plant = await createTestPlant(prisma, project.id);

    const response = await postRepair(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ plantId: plant.id }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ added: 0, skippedExisting: 0, preservedManual: 0, noApplicableVersion: 0, failed: 0 });
  });
});
