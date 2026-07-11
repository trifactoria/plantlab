export type PropagationTarget = "later-without-crop" | "all-without-crop";

export type PropagationCandidatePhoto = {
  id: string;
  timestamp: Date;
};

export type PropagationPlan = {
  /** Photos that will receive the propagated crop. */
  targetPhotoIds: string[];
  /** Photos skipped because they already have a crop and overwrite was not requested. */
  skippedExistingCount: number;
};

/**
 * Pure decision logic for crop propagation - no I/O, so it's easy to unit
 * test. Never includes the source photo itself, never overwrites an
 * existing crop unless `overwrite` is set, and is limited to the photo list
 * the caller passes in (the caller is responsible for scoping that list to
 * a single project).
 */
export function planCropPropagation(options: {
  target: PropagationTarget;
  sourcePhoto: PropagationCandidatePhoto;
  projectPhotos: PropagationCandidatePhoto[];
  existingCropPhotoIds: Set<string>;
  overwrite: boolean;
}): PropagationPlan {
  const { target, sourcePhoto, projectPhotos, existingCropPhotoIds, overwrite } = options;

  const candidates = projectPhotos.filter((photo) => {
    if (photo.id === sourcePhoto.id) {
      return false;
    }

    if (target === "later-without-crop") {
      return photo.timestamp.getTime() >= sourcePhoto.timestamp.getTime();
    }

    return true;
  });

  const targetPhotoIds: string[] = [];
  let skippedExistingCount = 0;

  for (const photo of candidates) {
    const hasExistingCrop = existingCropPhotoIds.has(photo.id);

    if (hasExistingCrop && !overwrite) {
      skippedExistingCount += 1;
      continue;
    }

    targetPhotoIds.push(photo.id);
  }

  return { targetPhotoIds, skippedExistingCount };
}
