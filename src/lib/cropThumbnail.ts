export type NormalizedCropRegion = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

export type ExtractRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Converts a normalized (0-1) crop into source-pixel coordinates for a
 * specific image, clamped so the extract region always stays inside the
 * actual image bounds (protects against rounding, stale crops saved against
 * a photo that has since changed on disk, etc).
 */
export function computeExtractRegion(
  crop: NormalizedCropRegion,
  imageWidth: number,
  imageHeight: number,
): ExtractRegion {
  const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(crop.cropX * imageWidth)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(crop.cropY * imageHeight)));
  const requestedWidth = Math.max(1, Math.round(crop.cropWidth * imageWidth));
  const requestedHeight = Math.max(1, Math.round(crop.cropHeight * imageHeight));
  const width = Math.max(0, Math.min(requestedWidth, imageWidth - left));
  const height = Math.max(0, Math.min(requestedHeight, imageHeight - top));

  return { left, top, width, height };
}

export const DEFAULT_THUMBNAIL_SIZE = 480;
export const MAX_THUMBNAIL_SIZE = 1600;

/** Parses and clamps a requested thumbnail size query parameter. */
export function resolveThumbnailSize(requested: string | null): number {
  const parsed = Number(requested);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_THUMBNAIL_SIZE;
  }

  return Math.min(MAX_THUMBNAIL_SIZE, Math.floor(parsed));
}

/** Builds a cache-busting thumbnail URL keyed on the crop's updatedAt. */
export function buildCropThumbnailUrl(
  crop: { id: string; updatedAt: Date | string },
  options: { size?: number } = {},
): string {
  const updatedAtMs = new Date(crop.updatedAt).getTime();
  const size = options.size ?? DEFAULT_THUMBNAIL_SIZE;
  return `/api/plant-photo-crops/${crop.id}/thumbnail?size=${size}&v=${updatedAtMs}`;
}
