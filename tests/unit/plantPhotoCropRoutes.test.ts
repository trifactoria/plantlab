import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteCrop, GET as getCrop, PATCH as patchCrop } from "../../src/app/api/plant-photo-crops/[cropId]/route";
import { GET as getThumbnail } from "../../src/app/api/plant-photo-crops/[cropId]/thumbnail/route";
import { POST as postCrop } from "../../src/app/api/plant-photo-crops/route";
import { POST as propagateCrop } from "../../src/app/api/plant-photo-crops/propagate/route";
import { GET as getVisualHistoryFrame } from "../../src/app/api/plants/[plantId]/visual-history/frame/route";
import { GET as getVisualHistoryIndex } from "../../src/app/api/plants/[plantId]/visual-history/route";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string) {
  return new Request(url, { method: "GET" });
}

describe("plant-photo-crop routes", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setUpProjectWithPlantAndPhotos(photoCount = 3) {
    const project = await createTestProject(prisma);
    const plant = await createTestPlant(prisma, project.id);
    const photos: Array<Awaited<ReturnType<typeof createRealPhoto>>> = [];
    for (let i = 0; i < photoCount; i += 1) {
      photos.push(
        await createRealPhoto(prisma, project.id, {
          timestamp: new Date(Date.UTC(2026, 6, 10 + i, 12, 0, 0)),
        }),
      );
    }

    cleanup.push(async () => {
      await prisma.plantPhotoCrop.deleteMany({ where: { plantId: plant.id } });
      for (const { directory } of photos) {
        await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined));
      }
      await cleanupTestProject(prisma, project.id, project.localPhotoDirectory);
    });

    return { project, plant, photos };
  }

  it("creates a crop via POST and validates plant/photo belong to the same project", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const otherProject = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));
    const otherPhoto = await createRealPhoto(prisma, otherProject.id);
    cleanup.push(async () => {
      await import("node:fs/promises").then((fs) => fs.rm(otherPhoto.directory, { recursive: true, force: true }).catch(() => undefined));
    });

    const goodResponse = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.5,
        cropHeight: 0.5,
      }),
    );
    expect(goodResponse.status).toBe(201);
    const created = await goodResponse.json();
    expect(created.plantId).toBe(plant.id);
    expect(created.photoId).toBe(photos[0].photo.id);
    expect(created.createdMethod).toBe("manual");
    const updatedPlant = await prisma.plant.findUnique({ where: { id: plant.id } });
    expect(updatedPlant?.visualAspectRatio).toBe("16:9");

    // Cross-project rejection.
    const crossProjectResponse = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: otherPhoto.photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.5,
        cropHeight: 0.5,
      }),
    );
    expect(crossProjectResponse.status).toBe(400);
    const crossProjectPayload = await crossProjectResponse.json();
    expect(crossProjectPayload.error).toMatch(/same project/);
  });

  it("rejects out-of-bounds crop coordinates", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);

    const response = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.8,
        cropY: 0.1,
        cropWidth: 0.5,
        cropHeight: 0.5,
      }),
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/fit inside/);
  });

  it("enforces one crop per plant/photo pair by upserting on repeated create", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);

    const first = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
      }),
    );
    const firstPayload = await first.json();

    const second = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.3,
        cropY: 0.3,
        cropWidth: 0.4,
        cropHeight: 0.4,
      }),
    );
    const secondPayload = await second.json();

    expect(secondPayload.id).toBe(firstPayload.id);
    expect(secondPayload.cropX).toBe(0.3);

    const count = await prisma.plantPhotoCrop.count({ where: { plantId: plant.id, photoId: photos[0].photo.id } });
    expect(count).toBe(1);
  });

  it("edits a crop via PATCH and rejects invalid bounds", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const created = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
      }),
    ).then((response) => response.json());

    const context = { params: Promise.resolve({ cropId: created.id }) };

    const patched = await patchCrop(
      jsonRequest(`http://localhost/api/plant-photo-crops/${created.id}`, { cropWidth: 0.6 }, "PATCH"),
      context,
    );
    expect(patched.status).toBe(200);
    const patchedPayload = await patched.json();
    expect(patchedPayload.cropWidth).toBe(0.6);

    const invalid = await patchCrop(
      jsonRequest(`http://localhost/api/plant-photo-crops/${created.id}`, { cropWidth: 5 }, "PATCH"),
      context,
    );
    expect(invalid.status).toBe(400);
  });

  it("deletes a crop via DELETE and reports 404 afterward", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const created = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
      }),
    ).then((response) => response.json());

    const context = { params: Promise.resolve({ cropId: created.id }) };
    const deleteResponse = await deleteCrop(getRequest("http://localhost/x"), context);
    expect(deleteResponse.status).toBe(200);

    const getResponse = await getCrop(getRequest("http://localhost/x"), context);
    expect(getResponse.status).toBe(404);
  });

  it("propagates a crop to later photos only, and skips photos that already have a crop", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(3);
    const [earlier, source, later] = photos;

    // Give the "later" photo its own pre-existing crop, which must survive untouched.
    await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: later.photo.id,
        cropX: 0.05,
        cropY: 0.05,
        cropWidth: 0.05,
        cropHeight: 0.05,
      }),
    );

    await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: source.photo.id,
        cropX: 0.2,
        cropY: 0.2,
        cropWidth: 0.3,
        cropHeight: 0.3,
      }),
    );

    const dryRun = await propagateCrop(
      jsonRequest("http://localhost/api/plant-photo-crops/propagate", {
        plantId: plant.id,
        sourcePhotoId: source.photo.id,
        target: "later-without-crop",
        dryRun: true,
      }),
    ).then((response) => response.json());

    // "later" already has a crop and is skipped; "earlier" is before the source and excluded.
    expect(dryRun.affectedCount).toBe(0);
    expect(dryRun.skippedExistingCount).toBe(1);

    const applied = await propagateCrop(
      jsonRequest("http://localhost/api/plant-photo-crops/propagate", {
        plantId: plant.id,
        sourcePhotoId: source.photo.id,
        target: "later-without-crop",
        dryRun: false,
      }),
    ).then((response) => response.json());
    expect(applied.affectedCount).toBe(0);

    // The earlier photo must still have no crop - propagation never applies to earlier photos.
    const earlierCrop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: earlier.photo.id } },
    });
    expect(earlierCrop).toBeNull();

    // The pre-existing "later" crop must be untouched (not overwritten).
    const laterCrop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: later.photo.id } },
    });
    expect(laterCrop?.cropWidth).toBe(0.05);
  });

  it("propagates to all photos without a crop when target is 'all-without-crop'", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(3);
    const [earlier, source] = photos;

    await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: source.photo.id,
        cropX: 0.2,
        cropY: 0.2,
        cropWidth: 0.3,
        cropHeight: 0.3,
      }),
    );

    const applied = await propagateCrop(
      jsonRequest("http://localhost/api/plant-photo-crops/propagate", {
        plantId: plant.id,
        sourcePhotoId: source.photo.id,
        target: "all-without-crop",
        dryRun: false,
      }),
    ).then((response) => response.json());

    expect(applied.affectedCount).toBe(2);

    const earlierCrop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: earlier.photo.id } },
    });
    expect(earlierCrop?.cropWidth).toBe(0.3);
    expect(earlierCrop?.createdMethod).toBe("propagated");
    expect(earlierCrop?.sourceCropId).toBeTruthy();
  });

  it("supports propagation dry-run before the source crop exists", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(3);
    const dryRun = await propagateCrop(
      jsonRequest("http://localhost/api/plant-photo-crops/propagate", {
        plantId: plant.id,
        sourcePhotoId: photos[1].photo.id,
        target: "all-without-crop",
        dryRun: true,
      }),
    ).then((response) => response.json());

    expect(dryRun.affectedCount).toBe(2);
    expect(dryRun.skippedExistingCount).toBe(0);
  });

  it("marks a propagated crop manual after edit", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(2);
    const [, later] = photos;

    const source = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.2,
        cropY: 0.2,
        cropWidth: 0.3,
        cropHeight: 0.3,
      }),
    ).then((response) => response.json());

    await propagateCrop(
      jsonRequest("http://localhost/api/plant-photo-crops/propagate", {
        plantId: plant.id,
        sourcePhotoId: photos[0].photo.id,
        target: "all-without-crop",
        dryRun: false,
      }),
    );

    const propagated = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: later.photo.id } },
    });
    expect(propagated?.createdMethod).toBe("propagated");
    expect(propagated?.sourceCropId).toBe(source.id);

    const context = { params: Promise.resolve({ cropId: propagated!.id }) };
    const response = await patchCrop(
      jsonRequest(`http://localhost/api/plant-photo-crops/${propagated!.id}`, { cropWidth: 0.25 }, "PATCH"),
      context,
    );
    expect(response.status).toBe(200);
    const edited = await response.json();
    expect(edited.createdMethod).toBe("manual");
    expect(edited.sourceCropId).toBeNull();
  });

  it("cascades: deleting a photo removes its PlantPhotoCrop rows", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const created = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
      }),
    ).then((response) => response.json());

    await prisma.photo.delete({ where: { id: photos[0].photo.id } });

    const stillExists = await prisma.plantPhotoCrop.findUnique({ where: { id: created.id } });
    expect(stillExists).toBeNull();
  });

  it("cascades: deleting a plant removes its PlantPhotoCrop rows", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const created = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
      }),
    ).then((response) => response.json());

    await prisma.plant.delete({ where: { id: plant.id } });

    const stillExists = await prisma.plantPhotoCrop.findUnique({ where: { id: created.id } });
    expect(stillExists).toBeNull();
  });

  it("lists visual-history frames in chronological order with pagination metadata", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(3);
    // Save crops out of chronological order to prove the index sorts by timestamp.
    for (const { photo } of [photos[2], photos[0], photos[1]]) {
      await postCrop(
        jsonRequest("http://localhost/api/plant-photo-crops", {
          plantId: plant.id,
          photoId: photo.id,
          cropX: 0.1,
          cropY: 0.1,
          cropWidth: 0.2,
          cropHeight: 0.2,
        }),
      );
    }

    const context = { params: Promise.resolve({ plantId: plant.id }) };
    const response = await getVisualHistoryIndex(getRequest(`http://localhost/x?limit=2`), context);
    const payload = await response.json();

    expect(payload.totalCount).toBe(3);
    expect(payload.frames).toHaveLength(2);
    expect(payload.frames[0].photoId).toBe(photos[0].photo.id);
    expect(payload.frames[1].photoId).toBe(photos[1].photo.id);
    expect(payload.hasMore).toBe(true);
  });

  it("returns frame detail (notes, crop ref, linked events) for a plant/photo pair", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
      }),
    );

    const event = await prisma.plantEvent.create({
      data: {
        projectId: photos[0].photo.projectId,
        plantId: plant.id,
        photoId: photos[0].photo.id,
        type: "Germinated",
        timestamp: photos[0].photo.timestamp,
      },
    });
    cleanup.push(async () => {
      await prisma.plantEvent.deleteMany({ where: { id: event.id } });
    });

    const context = { params: Promise.resolve({ plantId: plant.id }) };
    const response = await getVisualHistoryFrame(
      getRequest(`http://localhost/x?photoId=${photos[0].photo.id}`),
      context,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.photo.id).toBe(photos[0].photo.id);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].type).toBe("Germinated");
  });

  it("returns 404 for frame detail when no crop exists for that plant/photo", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const context = { params: Promise.resolve({ plantId: plant.id }) };
    const response = await getVisualHistoryFrame(
      getRequest(`http://localhost/x?photoId=${photos[0].photo.id}`),
      context,
    );
    expect(response.status).toBe(404);
  });

  it("serves a crop thumbnail as an image", async () => {
    const { plant, photos } = await setUpProjectWithPlantAndPhotos(1);
    const created = await postCrop(
      jsonRequest("http://localhost/api/plant-photo-crops", {
        plantId: plant.id,
        photoId: photos[0].photo.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.3,
        cropHeight: 0.3,
      }),
    ).then((response) => response.json());

    const context = { params: Promise.resolve({ cropId: created.id }) };
    const response = await getThumbnail(getRequest("http://localhost/x?size=64"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("X-Source-Crop-Width")).toBe("60");
    expect(response.headers.get("X-Source-Crop-Height")).toBe("45");
    expect(response.headers.get("X-Output-Width")).toBe("60");
    expect(response.headers.get("X-Output-Height")).toBe("45");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("returns 404 for a thumbnail of a non-existent crop", async () => {
    const context = { params: Promise.resolve({ cropId: "does-not-exist" }) };
    const response = await getThumbnail(getRequest("http://localhost/x"), context);
    expect(response.status).toBe(404);
  });
});
