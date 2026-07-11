export type DiscoveredCameraIdentity = {
  device: string;
  stableId: string | null;
};

export type StableCameraMatch = {
  /** The discovered camera whose stableId matches the saved one, if any. */
  matched: DiscoveredCameraIdentity | null;
  /** True when the match was found at a different /dev/video path than saved. */
  devicePathChanged: boolean;
};

/**
 * Pure matching logic (no I/O) so it can run in the browser and be unit
 * tested without hardware. Never treats a reused /dev/video path as a match
 * by itself - only an equal stableId counts, so a different physical
 * camera that happens to land on the same device number is never silently
 * bound to a project.
 */
export function matchSavedCamera(
  discovered: DiscoveredCameraIdentity[],
  saved: { stableId: string | null; device: string | null },
): StableCameraMatch {
  if (!saved.stableId) {
    return { matched: null, devicePathChanged: false };
  }

  const matched = discovered.find((camera) => camera.stableId === saved.stableId) ?? null;

  if (!matched) {
    return { matched: null, devicePathChanged: false };
  }

  return { matched, devicePathChanged: matched.device !== saved.device };
}
