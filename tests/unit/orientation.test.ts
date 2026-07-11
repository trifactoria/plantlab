import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  applyOrientation,
  isValidRotation,
  parseRotation,
  transformedDimensions,
} from "../../src/lib/orientation";

/** Red top-left, green top-right, blue bottom-left, yellow bottom-right. */
async function quadrantImage(width: number, height: number) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect x="0" y="0" width="${halfW}" height="${halfH}" fill="#ff0000"/>
      <rect x="${halfW}" y="0" width="${width - halfW}" height="${halfH}" fill="#00ff00"/>
      <rect x="0" y="${halfH}" width="${halfW}" height="${height - halfH}" fill="#0000ff"/>
      <rect x="${halfW}" y="${halfH}" width="${width - halfW}" height="${height - halfH}" fill="#ffff00"/>
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

async function pixelAt(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

function isRed(pixel: { r: number; g: number; b: number }) {
  return pixel.r > 200 && pixel.g < 60 && pixel.b < 60;
}
function isGreen(pixel: { r: number; g: number; b: number }) {
  return pixel.r < 60 && pixel.g > 200 && pixel.b < 60;
}
function isBlue(pixel: { r: number; g: number; b: number }) {
  return pixel.r < 60 && pixel.g < 60 && pixel.b > 200;
}

describe("isValidRotation / parseRotation", () => {
  it("accepts only 0, 90, 180, 270", () => {
    expect(isValidRotation(0)).toBe(true);
    expect(isValidRotation(90)).toBe(true);
    expect(isValidRotation(180)).toBe(true);
    expect(isValidRotation(270)).toBe(true);
    expect(isValidRotation(45)).toBe(false);
    expect(isValidRotation(360)).toBe(false);
  });

  it("throws for an unsupported rotation", () => {
    expect(() => parseRotation(45)).toThrow(/Unsupported rotation/);
  });
});

describe("transformedDimensions", () => {
  it("keeps width/height for 0 and 180 degrees", () => {
    expect(transformedDimensions(3840, 2160, 0)).toEqual({ width: 3840, height: 2160 });
    expect(transformedDimensions(3840, 2160, 180)).toEqual({ width: 3840, height: 2160 });
  });

  it("swaps width/height for 90 and 270 degrees", () => {
    expect(transformedDimensions(3840, 2160, 90)).toEqual({ width: 2160, height: 3840 });
    expect(transformedDimensions(3840, 2160, 270)).toEqual({ width: 2160, height: 3840 });
  });

  it("is self-inverse (applying it twice returns to the original for 90/270)", () => {
    const once = transformedDimensions(3840, 2160, 90);
    const twice = transformedDimensions(once.width, once.height, 90);
    expect(twice).toEqual({ width: 3840, height: 2160 });
  });
});

describe("applyOrientation (pixel-level)", () => {
  it("rotation 0 leaves the frame unchanged - red stays top-left", async () => {
    const raw = await quadrantImage(200, 100);
    const out = await applyOrientation(sharp(raw), { rotation: 0, flipHorizontal: false, flipVertical: false })
      .jpeg()
      .toBuffer();
    const pixel = await pixelAt(out, 10, 10);
    expect(isRed(pixel)).toBe(true);
  });

  it("rotation 90 (clockwise) moves the original top-left quadrant to the top-right", async () => {
    const raw = await quadrantImage(200, 100);
    const out = await applyOrientation(sharp(raw), { rotation: 90, flipHorizontal: false, flipVertical: false })
      .jpeg()
      .toBuffer();
    // Working frame is now 100 wide x 200 tall.
    const pixel = await pixelAt(out, 90, 10);
    expect(isRed(pixel)).toBe(true);
  });

  it("rotation 180 moves the original top-left quadrant to the bottom-right", async () => {
    const raw = await quadrantImage(200, 100);
    const out = await applyOrientation(sharp(raw), { rotation: 180, flipHorizontal: false, flipVertical: false })
      .jpeg()
      .toBuffer();
    const pixel = await pixelAt(out, 190, 90);
    expect(isRed(pixel)).toBe(true);
  });

  it("horizontal flip moves the original top-left quadrant to the top-right", async () => {
    const raw = await quadrantImage(200, 100);
    const out = await applyOrientation(sharp(raw), { rotation: 0, flipHorizontal: true, flipVertical: false })
      .jpeg()
      .toBuffer();
    const pixel = await pixelAt(out, 190, 10);
    expect(isRed(pixel)).toBe(true);
  });

  it("vertical flip moves the original top-left quadrant to the bottom-left", async () => {
    const raw = await quadrantImage(200, 100);
    const out = await applyOrientation(sharp(raw), { rotation: 0, flipHorizontal: false, flipVertical: true })
      .jpeg()
      .toBuffer();
    const pixel = await pixelAt(out, 10, 90);
    expect(isRed(pixel)).toBe(true);
  });

  it("does not mutate the original buffer's bytes", async () => {
    const raw = await quadrantImage(200, 100);
    const rawCopy = Buffer.from(raw);
    await applyOrientation(sharp(raw), { rotation: 90, flipHorizontal: true, flipVertical: true }).jpeg().toBuffer();
    expect(Buffer.compare(raw, rawCopy)).toBe(0);
  });
});

describe("quadrant test fixture sanity", () => {
  it("green is top-right and blue is bottom-left in the fixture itself", async () => {
    const raw = await quadrantImage(200, 100);
    expect(isGreen(await pixelAt(raw, 190, 10))).toBe(true);
    expect(isBlue(await pixelAt(raw, 10, 90))).toBe(true);
  });
});
