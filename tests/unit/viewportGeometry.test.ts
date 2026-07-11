import { describe, expect, it } from "vitest";
import { findOverlappingPairs, pixelDimensionsForRect, rectanglesOverlap } from "../../src/lib/viewportGeometry";

describe("rectanglesOverlap", () => {
  it("detects overlap between intersecting rectangles", () => {
    const a = { cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 0.5 };
    const b = { cropX: 0.25, cropY: 0.25, cropWidth: 0.5, cropHeight: 0.5 };
    expect(rectanglesOverlap(a, b)).toBe(true);
  });

  it("reports no overlap for adjacent, non-intersecting rectangles", () => {
    const a = { cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 0.5 };
    const b = { cropX: 0.5, cropY: 0, cropWidth: 0.5, cropHeight: 0.5 };
    expect(rectanglesOverlap(a, b)).toBe(false);
  });
});

describe("findOverlappingPairs", () => {
  it("finds every overlapping pair among several rectangles", () => {
    const rects = [
      { id: "a", cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 0.5 },
      { id: "b", cropX: 0.25, cropY: 0.25, cropWidth: 0.5, cropHeight: 0.5 },
      { id: "c", cropX: 0.8, cropY: 0.8, cropWidth: 0.1, cropHeight: 0.1 },
    ];
    const pairs = findOverlappingPairs(rects);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("returns no pairs when nothing overlaps", () => {
    const rects = [
      { id: "a", cropX: 0, cropY: 0, cropWidth: 0.2, cropHeight: 0.2 },
      { id: "b", cropX: 0.5, cropY: 0.5, cropWidth: 0.2, cropHeight: 0.2 },
    ];
    expect(findOverlappingPairs(rects)).toHaveLength(0);
  });
});

describe("pixelDimensionsForRect", () => {
  it("scales a normalized rectangle to the frame's pixel dimensions", () => {
    const rect = { cropX: 0.1, cropY: 0.1, cropWidth: 0.25, cropHeight: 0.5 };
    expect(pixelDimensionsForRect(rect, 3840, 2160)).toEqual({ width: 960, height: 1080 });
  });

  it("never returns a zero or negative dimension", () => {
    const rect = { cropX: 0, cropY: 0, cropWidth: 0.0001, cropHeight: 0.0001 };
    const result = pixelDimensionsForRect(rect, 100, 100);
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });
});
