import { describe, expect, it } from "vitest";
import {
  clamp,
  computeRelativeSharpness,
  containRect,
  fractionWithinRect,
} from "../../src/lib/imageGeometry";

function fakeImageData(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

describe("clamp", () => {
  it("clamps below the minimum and above the maximum", () => {
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe("containRect (object-fit: contain letterboxing)", () => {
  it("letterboxes top/bottom when the image is wider than the container", () => {
    // 400x100 container, 200x200 (square) image -> image renders 100x100, centered vertically.
    const rect = containRect(400, 100, 200, 200);
    expect(rect.width).toBeCloseTo(100);
    expect(rect.height).toBeCloseTo(100);
    expect(rect.x).toBeCloseTo(150);
    expect(rect.y).toBeCloseTo(0);
  });

  it("letterboxes left/right when the image is taller than the container", () => {
    // 100x400 container, 200x200 (square) image -> image renders 100x100, centered horizontally.
    const rect = containRect(100, 400, 200, 200);
    expect(rect.width).toBeCloseTo(100);
    expect(rect.height).toBeCloseTo(100);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(150);
  });

  it("fills the container exactly with no letterboxing when aspect ratios match", () => {
    const rect = containRect(300, 200, 600, 400);
    expect(rect).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
});

describe("fractionWithinRect (zoom-agnostic coordinate mapping)", () => {
  it("maps a point at the top-left corner to (0, 0)", () => {
    const point = fractionWithinRect(50, 80, { left: 50, top: 80, width: 200, height: 100 });
    expect(point).toEqual({ x: 0, y: 0 });
  });

  it("maps a point at the bottom-right corner to (1, 1)", () => {
    const point = fractionWithinRect(250, 180, { left: 50, top: 80, width: 200, height: 100 });
    expect(point?.x).toBeCloseTo(1);
    expect(point?.y).toBeCloseTo(1);
  });

  it("maps the center to (0.5, 0.5) regardless of the rect's size (simulating different zoom levels)", () => {
    const unzoomed = fractionWithinRect(150, 130, { left: 50, top: 80, width: 200, height: 100 });
    // Same relative point, but the rect is 3x larger (as if zoomed in 3x) and offset differently.
    const zoomed = fractionWithinRect(500, 350, { left: 200, top: 200, width: 600, height: 300 });

    expect(unzoomed?.x).toBeCloseTo(0.5);
    expect(unzoomed?.y).toBeCloseTo(0.5);
    expect(zoomed?.x).toBeCloseTo(0.5);
    expect(zoomed?.y).toBeCloseTo(0.5);
  });

  it("clamps points outside the rect to the [0, 1] range", () => {
    const point = fractionWithinRect(-100, 5000, { left: 0, top: 0, width: 200, height: 100 });
    expect(point).toEqual({ x: 0, y: 1 });
  });

  it("returns null for a degenerate (zero-size) rect", () => {
    expect(fractionWithinRect(10, 10, { left: 0, top: 0, width: 0, height: 100 })).toBeNull();
  });
});

describe("computeRelativeSharpness", () => {
  it("scores a perfectly flat region as zero", () => {
    const flat = fakeImageData(8, 8, () => [128, 128, 128]);
    expect(computeRelativeSharpness(flat)).toBe(0);
  });

  it("scores a region with a hard edge higher than a flat region", () => {
    const edge = fakeImageData(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const flat = fakeImageData(8, 8, () => [128, 128, 128]);
    expect(computeRelativeSharpness(edge)).toBeGreaterThan(computeRelativeSharpness(flat));
  });
});
