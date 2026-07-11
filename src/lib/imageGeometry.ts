export type Rect = { x: number; y: number; width: number; height: number };

/** Where an object-fit: contain image actually renders within its box. */
export function containRect(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): Rect {
  const containerRatio = containerWidth / containerHeight;
  const imageRatio = naturalWidth / naturalHeight;

  if (imageRatio > containerRatio) {
    const width = containerWidth;
    const height = width / imageRatio;
    return { x: 0, y: (containerHeight - height) / 2, width, height };
  }

  const height = containerHeight;
  const width = height * imageRatio;
  return { x: (containerWidth - width) / 2, y: 0, width, height };
}

/**
 * A crude, purely relative edge-strength score (average horizontal
 * grayscale gradient magnitude). Not a scientific sharpness measurement -
 * only meant to help compare "more" vs "less" detail between two regions.
 */
export function computeRelativeSharpness(imageData: ImageData): number {
  const { data, width, height } = imageData;
  let total = 0;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      const j = i + 4;
      const gray1 = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const gray2 = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      total += Math.abs(gray1 - gray2);
      count += 1;
    }
  }

  return count > 0 ? total / count : 0;
}

/** Clamps a value to the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export type ClientRect = { left: number; top: number; width: number; height: number };

/**
 * Converts a client (viewport) point into a 0-1 fraction of a given
 * on-screen rect, clamped to [0, 1]. Deliberately takes the rect's *actual*
 * on-screen box (e.g. from getBoundingClientRect() after any CSS zoom/pan
 * transform) rather than any zoom/pan state directly - so the result stays
 * correct no matter how the caller implements zooming or panning, as long
 * as the rect always represents exactly the image's rendered content box.
 */
export function fractionWithinRect(clientX: number, clientY: number, rect: ClientRect) {
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
  };
}
