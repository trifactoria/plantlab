import { describe, expect, it } from "vitest";
import { planCropPropagation } from "../../src/lib/plantPhotoCropPropagation";

const sourcePhoto = { id: "source", timestamp: new Date("2026-07-10T12:00:00Z") };

const projectPhotos = [
  { id: "before", timestamp: new Date("2026-07-09T12:00:00Z") },
  sourcePhoto,
  { id: "later-1", timestamp: new Date("2026-07-11T12:00:00Z") },
  { id: "later-2", timestamp: new Date("2026-07-12T12:00:00Z") },
];

describe("planCropPropagation", () => {
  it("targets only photos at or after the source timestamp for 'later-without-crop', excluding the source", () => {
    const plan = planCropPropagation({
      target: "later-without-crop",
      sourcePhoto,
      projectPhotos,
      existingCropPhotoIds: new Set(),
      overwrite: false,
    });

    expect(plan.targetPhotoIds.sort()).toEqual(["later-1", "later-2"]);
    expect(plan.skippedExistingCount).toBe(0);
  });

  it("targets every other project photo for 'all-without-crop', excluding the source", () => {
    const plan = planCropPropagation({
      target: "all-without-crop",
      sourcePhoto,
      projectPhotos,
      existingCropPhotoIds: new Set(),
      overwrite: false,
    });

    expect(plan.targetPhotoIds.sort()).toEqual(["before", "later-1", "later-2"]);
  });

  it("never overwrites a photo that already has a crop unless overwrite is set", () => {
    const plan = planCropPropagation({
      target: "all-without-crop",
      sourcePhoto,
      projectPhotos,
      existingCropPhotoIds: new Set(["later-1"]),
      overwrite: false,
    });

    expect(plan.targetPhotoIds.sort()).toEqual(["before", "later-2"]);
    expect(plan.skippedExistingCount).toBe(1);
  });

  it("includes photos with an existing crop when overwrite is explicitly requested", () => {
    const plan = planCropPropagation({
      target: "all-without-crop",
      sourcePhoto,
      projectPhotos,
      existingCropPhotoIds: new Set(["later-1"]),
      overwrite: true,
    });

    expect(plan.targetPhotoIds.sort()).toEqual(["before", "later-1", "later-2"]);
    expect(plan.skippedExistingCount).toBe(0);
  });

  it("returns an empty plan when there are no candidate photos", () => {
    const plan = planCropPropagation({
      target: "later-without-crop",
      sourcePhoto,
      projectPhotos: [sourcePhoto],
      existingCropPhotoIds: new Set(),
      overwrite: false,
    });

    expect(plan.targetPhotoIds).toEqual([]);
    expect(plan.skippedExistingCount).toBe(0);
  });
});
