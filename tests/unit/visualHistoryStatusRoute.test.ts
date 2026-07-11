import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { GET as getVisualHistory } from "../../src/app/api/plants/[plantId]/visual-history/route";
import { POST as postCropVersion } from "../../src/app/api/plants/[plantId]/crop-versions/route";
import { materializeCropsForNewPhoto } from "../../src/lib/cropVersions";
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

describe("visual-history index reflects materialized crops", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  it("a newly captured/materialized photo appears as a frame and the status/frame counts agree", async () => {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    const plant = await createTestPlant(prisma, project.id);

    const { photo: seedPhoto, directory: dir1 } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-01T08:00:00.000Z"),
    });
    cleanup.push(() => rm(dir1, { recursive: true, force: true }).catch(() => undefined));

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

    const before = await getVisualHistory(new Request("http://localhost"), {
      params: Promise.resolve({ plantId: plant.id }),
    });
    const beforePayload = await before.json();
    expect(beforePayload.totalCount).toBe(1);
    expect(beforePayload.status.materializedCount).toBe(1);

    // Simulate a new capture arriving through the shared materialization hook.
    const { photo: newPhoto, directory: dir2 } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-02T08:00:00.000Z"),
    });
    cleanup.push(() => rm(dir2, { recursive: true, force: true }).catch(() => undefined));
    await materializeCropsForNewPhoto(prisma, newPhoto);

    const after = await getVisualHistory(new Request("http://localhost"), {
      params: Promise.resolve({ plantId: plant.id }),
    });
    const afterPayload = await after.json();
    expect(afterPayload.totalCount).toBe(2);
    expect(afterPayload.frames.map((frame: { photoId: string }) => frame.photoId)).toContain(newPhoto.id);
    expect(afterPayload.status.materializedCount).toBe(2);
    expect(afterPayload.status.missingCount).toBe(0);
  });
});
