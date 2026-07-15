import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { verifyCapturedDimensions } from "../../src/lib/captureVerify";

async function jpegBuffer(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const index = offset / 3;
    const x = index % width;
    const y = Math.floor(index / width);
    pixels[offset] = x % 256;
    pixels[offset + 1] = y % 256;
    pixels[offset + 2] = (x + y) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe("verifyCapturedDimensions", () => {
  it("reports a match when the actual image matches the requested dimensions", async () => {
    const buffer = await jpegBuffer(3840, 2160);
    const result = await verifyCapturedDimensions(buffer, { width: 3840, height: 2160 });

    expect(result).toMatchObject({
      requestedWidth: 3840,
      requestedHeight: 2160,
      actualWidth: 3840,
      actualHeight: 2160,
      matched: true,
    });
    expect(result.byteSize).toBe(buffer.length);
  });

  it("rejects a camera falling back to a lower resolution than requested", async () => {
    const buffer = await jpegBuffer(1920, 1080);

    await expect(verifyCapturedDimensions(buffer, { width: 3840, height: 2160 })).rejects.toThrow(/did not match expected width/);
  });

  it("throws for bytes that are not a readable image", async () => {
    await expect(verifyCapturedDimensions(Buffer.from("not an image"), { width: 100, height: 100 })).rejects.toThrow();
  });
});
