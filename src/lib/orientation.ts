import type { Sharp } from "sharp";

export type Rotation = 0 | 90 | 180 | 270;

export type Orientation = {
  rotation: Rotation;
  flipHorizontal: boolean;
  flipVertical: boolean;
};

const VALID_ROTATIONS: Rotation[] = [0, 90, 180, 270];

export function isValidRotation(value: number): value is Rotation {
  return VALID_ROTATIONS.includes(value as Rotation);
}

export function parseRotation(value: number): Rotation {
  if (!isValidRotation(value)) {
    throw new Error(`Unsupported rotation: ${value}. Must be one of 0, 90, 180, 270.`);
  }

  return value;
}

/**
 * Dimensions after applying this orientation to a raw, un-rotated
 * width/height. A 90 or 270 degree rotation swaps width and height; flips
 * never change dimensions. This is what CaptureSource.width/height (and
 * SourceCapture.workingWidth/height) store - project viewport rectangles
 * are normalized against these transformed dimensions, not the raw capture.
 */
export function transformedDimensions(
  rawWidth: number,
  rawHeight: number,
  rotation: Rotation,
): { width: number; height: number } {
  if (rotation === 90 || rotation === 270) {
    return { width: rawHeight, height: rawWidth };
  }

  return { width: rawWidth, height: rawHeight };
}

/**
 * Applies this orientation to a Sharp pipeline: rotation first, then
 * horizontal/vertical flip - matching the documented rule that orientation
 * is resolved before any viewport/crop geometry is interpreted. The
 * original source file on disk is never touched; this only ever transforms
 * an in-memory pipeline used to build a preview or a derived crop.
 */
export function applyOrientation(image: Sharp, orientation: Orientation): Sharp {
  let out = image;

  if (orientation.rotation !== 0) {
    out = out.rotate(orientation.rotation);
  }

  if (orientation.flipHorizontal) {
    out = out.flop();
  }

  if (orientation.flipVertical) {
    out = out.flip();
  }

  return out;
}
