import { describe, expect, it } from "vitest";
import {
  calculatePreviewCanvasSize,
  changeCropShapePreserveCenter,
  createCropFromDrag,
  cropPixelDimensions,
  inferInitialShapeFromDrag,
  resizeCropFromCorner,
} from "../../src/lib/cropGeometry";

const imageSize = { width: 1600, height: 900 };

function sourceRatio(crop: { cropWidth: number; cropHeight: number }) {
  return (crop.cropWidth * imageSize.width) / (crop.cropHeight * imageSize.height);
}

describe("crop geometry", () => {
  it("selects 16:9 for a primarily horizontal initial drag", () => {
    expect(inferInitialShapeFromDrag({ x: 0.1, y: 0.1 }, { x: 0.7, y: 0.25 })).toBe("16:9");
  });

  it("selects 9:16 for a primarily vertical initial drag", () => {
    expect(inferInitialShapeFromDrag({ x: 0.1, y: 0.1 }, { x: 0.25, y: 0.8 })).toBe("9:16");
  });

  it("creates a 16:9 source crop from a drag", () => {
    const crop = createCropFromDrag({ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }, "16:9", imageSize);
    expect(crop).not.toBeNull();
    expect(sourceRatio(crop!)).toBeCloseTo(16 / 9, 6);
  });

  it("creates a 9:16 source crop from a drag", () => {
    const crop = createCropFromDrag({ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }, "9:16", imageSize);
    expect(crop).not.toBeNull();
    expect(sourceRatio(crop!)).toBeCloseTo(9 / 16, 6);
  });

  it.each(["nw", "ne", "se", "sw"] as const)("preserves ratio when resizing from %s", (handle) => {
    const origin = createCropFromDrag({ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.6 }, "16:9", imageSize)!;
    const resized = resizeCropFromCorner(origin, handle, { x: 0.05, y: 0.85 }, "16:9", imageSize);
    expect(sourceRatio(resized)).toBeCloseTo(16 / 9, 6);
  });

  it("clamps near image boundaries while preserving ratio", () => {
    const origin = createCropFromDrag({ x: 0.6, y: 0.6 }, { x: 0.9, y: 0.8 }, "1:1", imageSize)!;
    const resized = resizeCropFromCorner(origin, "se", { x: 1.2, y: 1.2 }, "1:1", imageSize);
    expect(resized.cropX + resized.cropWidth).toBeLessThanOrEqual(1);
    expect(resized.cropY + resized.cropHeight).toBeLessThanOrEqual(1);
    expect(sourceRatio(resized)).toBeCloseTo(1, 6);
  });

  it("converts landscape to portrait around the crop center", () => {
    const crop = { cropX: 0.25, cropY: 0.25, cropWidth: 0.4, cropHeight: 0.225 };
    const beforeCenter = { x: crop.cropX + crop.cropWidth / 2, y: crop.cropY + crop.cropHeight / 2 };
    const converted = changeCropShapePreserveCenter(crop, "9:16", imageSize);
    const afterCenter = {
      x: converted.cropX + converted.cropWidth / 2,
      y: converted.cropY + converted.cropHeight / 2,
    };
    expect(afterCenter.x).toBeCloseTo(beforeCenter.x, 6);
    expect(afterCenter.y).toBeCloseTo(beforeCenter.y, 6);
    expect(sourceRatio(converted)).toBeCloseTo(9 / 16, 6);
  });

  it("calculates source pixel dimensions", () => {
    expect(cropPixelDimensions({ cropX: 0, cropY: 0, cropWidth: 0.25, cropHeight: 0.5 }, imageSize)).toEqual({
      width: 400,
      height: 450,
    });
  });

  it("calculates ratio-aware preview canvas dimensions", () => {
    expect(calculatePreviewCanvasSize(16 / 9)).toEqual({ width: 320, height: 180 });
    expect(calculatePreviewCanvasSize(9 / 16)).toEqual({ width: 180, height: 320 });
    expect(calculatePreviewCanvasSize(1)).toEqual({ width: 240, height: 240 });
  });

  it("keeps legacy freeform crop ratios instead of forcing a standard shape", () => {
    const freeform = createCropFromDrag({ x: 0.1, y: 0.2 }, { x: 0.52, y: 0.77 }, "free", imageSize)!;
    expect(freeform.cropX).toBeCloseTo(0.1, 6);
    expect(freeform.cropY).toBeCloseTo(0.2, 6);
    expect(freeform.cropWidth).toBeCloseTo(0.42, 6);
    expect(freeform.cropHeight).toBeCloseTo(0.57, 6);
  });
});
