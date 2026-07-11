import { clamp } from "@/lib/imageGeometry";

export type CropValue = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

export type CropShape = "16:9" | "9:16" | "1:1" | "free";
export type CropCornerHandle = "nw" | "ne" | "se" | "sw";
export type CropResizeHandle = CropCornerHandle | "n" | "s" | "e" | "w";
export type ImageSize = { width: number; height: number };
export type Point = { x: number; y: number };

export const MIN_CROP_SIZE = 0.01;

export const CROP_SHAPE_LABELS: Record<CropShape, string> = {
  "16:9": "Landscape 16:9",
  "9:16": "Portrait 9:16",
  "1:1": "Square 1:1",
  free: "Free",
};

export function cropShapeRatio(shape: CropShape): number | null {
  if (shape === "16:9") {
    return 16 / 9;
  }
  if (shape === "9:16") {
    return 9 / 16;
  }
  if (shape === "1:1") {
    return 1;
  }
  return null;
}

export function normalizedRatioForShape(shape: CropShape, imageSize: ImageSize): number | null {
  const outputRatio = cropShapeRatio(shape);
  if (!outputRatio || imageSize.width <= 0 || imageSize.height <= 0) {
    return null;
  }

  return outputRatio * (imageSize.height / imageSize.width);
}

export function inferInitialShapeFromDrag(start: Point, end: Point): CropShape {
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? "16:9" : "9:16";
}

export function cropPixelDimensions(crop: CropValue, imageSize: ImageSize) {
  return {
    width: Math.max(1, Math.round(crop.cropWidth * imageSize.width)),
    height: Math.max(1, Math.round(crop.cropHeight * imageSize.height)),
  };
}

export function cropOutputRatio(crop: CropValue, imageSize: ImageSize): number {
  const dimensions = cropPixelDimensions(crop, imageSize);
  return dimensions.width / dimensions.height;
}

export function cropOrientationLabel(crop: CropValue, imageSize: ImageSize, shape: CropShape = "free") {
  if (shape !== "free") {
    return CROP_SHAPE_LABELS[shape];
  }

  const ratio = cropOutputRatio(crop, imageSize);
  if (Math.abs(ratio - 1) < 0.03) {
    return "Free 1:1";
  }
  return ratio > 1 ? "Free landscape" : "Free portrait";
}

export function calculatePreviewCanvasSize(
  cropOrRatio: CropValue | number,
  imageSize?: ImageSize,
  maxWidth = 320,
  maxHeight = 320,
  squareSize = 240,
) {
  const ratio =
    typeof cropOrRatio === "number"
      ? cropOrRatio
      : imageSize
        ? cropOutputRatio(cropOrRatio, imageSize)
        : cropOrRatio.cropWidth / cropOrRatio.cropHeight;

  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { width: squareSize, height: squareSize };
  }

  if (Math.abs(ratio - 1) < 0.01) {
    return { width: squareSize, height: squareSize };
  }

  if (ratio > 1) {
    const width = maxWidth;
    return { width, height: Math.max(1, Math.round(width / ratio)) };
  }

  const height = maxHeight;
  return { width: Math.max(1, Math.round(height * ratio)), height };
}

export function clampCropInsideBounds(crop: CropValue): CropValue {
  const width = clamp(crop.cropWidth, MIN_CROP_SIZE, 1);
  const height = clamp(crop.cropHeight, MIN_CROP_SIZE, 1);

  return {
    cropX: clamp(crop.cropX, 0, 1 - width),
    cropY: clamp(crop.cropY, 0, 1 - height),
    cropWidth: width,
    cropHeight: height,
  };
}

export function clampConstrainedCropInsideBounds(crop: CropValue, normalizedRatio: number): CropValue {
  let width = Math.max(MIN_CROP_SIZE, crop.cropWidth);
  let height = width / normalizedRatio;

  if (height > 1) {
    height = 1;
    width = height * normalizedRatio;
  }
  if (width > 1) {
    width = 1;
    height = width / normalizedRatio;
  }

  return {
    cropX: clamp(crop.cropX, 0, 1 - width),
    cropY: clamp(crop.cropY, 0, 1 - height),
    cropWidth: width,
    cropHeight: height,
  };
}

export function createCropFromDrag(start: Point, end: Point, shape: CropShape, imageSize: ImageSize): CropValue | null {
  const rawWidth = Math.abs(end.x - start.x);
  const rawHeight = Math.abs(end.y - start.y);

  if (rawWidth <= 0 || rawHeight <= 0) {
    return null;
  }

  if (shape === "free") {
    return rawWidth > 0 && rawHeight > 0
      ? clampCropInsideBounds({
          cropX: Math.min(start.x, end.x),
          cropY: Math.min(start.y, end.y),
          cropWidth: rawWidth,
          cropHeight: rawHeight,
        })
      : null;
  }

  const normalizedRatio = normalizedRatioForShape(shape, imageSize);
  if (!normalizedRatio) {
    return null;
  }

  const maxWidthFromAnchor = end.x >= start.x ? 1 - start.x : start.x;
  const maxHeightFromAnchor = end.y >= start.y ? 1 - start.y : start.y;
  let width = Math.min(rawWidth, maxWidthFromAnchor);
  let height = width / normalizedRatio;

  if (height > rawHeight || height > maxHeightFromAnchor) {
    height = Math.min(rawHeight, maxHeightFromAnchor);
    width = height * normalizedRatio;
  }

  if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) {
    return null;
  }

  const cropX = end.x >= start.x ? start.x : start.x - width;
  const cropY = end.y >= start.y ? start.y : start.y - height;

  return clampConstrainedCropInsideBounds({ cropX, cropY, cropWidth: width, cropHeight: height }, normalizedRatio);
}

export function resizeCropFromCorner(
  origin: CropValue,
  handle: CropResizeHandle,
  point: Point,
  shape: CropShape,
  imageSize: ImageSize,
): CropValue {
  const anchoredRight = origin.cropX + origin.cropWidth;
  const anchoredBottom = origin.cropY + origin.cropHeight;
  const fixedX = handle.includes("w") ? anchoredRight : origin.cropX;
  const fixedY = handle.includes("n") ? anchoredBottom : origin.cropY;
  const start = { x: fixedX, y: fixedY };

  if (shape === "free") {
    const left = handle.includes("w") ? clamp(point.x, 0, anchoredRight - MIN_CROP_SIZE) : origin.cropX;
    const top = handle.includes("n") ? clamp(point.y, 0, anchoredBottom - MIN_CROP_SIZE) : origin.cropY;
    const right = handle.includes("e") ? clamp(point.x, origin.cropX + MIN_CROP_SIZE, 1) : anchoredRight;
    const bottom = handle.includes("s") ? clamp(point.y, origin.cropY + MIN_CROP_SIZE, 1) : anchoredBottom;
    return { cropX: left, cropY: top, cropWidth: right - left, cropHeight: bottom - top };
  }

  const normalizedRatio = normalizedRatioForShape(shape, imageSize);
  if (!normalizedRatio) {
    return origin;
  }

  return createCropFromDrag(start, point, shape, imageSize) ?? origin;
}

export function changeCropShapePreserveCenter(crop: CropValue, nextShape: CropShape, imageSize: ImageSize): CropValue {
  if (nextShape === "free") {
    return clampCropInsideBounds(crop);
  }

  const normalizedRatio = normalizedRatioForShape(nextShape, imageSize);
  if (!normalizedRatio) {
    return crop;
  }

  const centerX = crop.cropX + crop.cropWidth / 2;
  const centerY = crop.cropY + crop.cropHeight / 2;
  const area = crop.cropWidth * crop.cropHeight;
  let width = Math.sqrt(area * normalizedRatio);
  let height = width / normalizedRatio;

  const maxWidth = Math.min(1, centerX * 2, (1 - centerX) * 2);
  const maxHeight = Math.min(1, centerY * 2, (1 - centerY) * 2);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  width = Math.max(MIN_CROP_SIZE, width * scale);
  height = width / normalizedRatio;

  if (height > maxHeight) {
    height = Math.max(MIN_CROP_SIZE, maxHeight);
    width = height * normalizedRatio;
  }

  return clampConstrainedCropInsideBounds(
    {
      cropX: centerX - width / 2,
      cropY: centerY - height / 2,
      cropWidth: width,
      cropHeight: height,
    },
    normalizedRatio,
  );
}
