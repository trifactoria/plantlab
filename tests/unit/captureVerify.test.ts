import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { verifyCapturedDimensions } from "../../src/lib/captureVerify";

async function jpegBuffer(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
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

  it("catches a camera falling back to a lower resolution than requested", async () => {
    const buffer = await jpegBuffer(1920, 1080);
    const result = await verifyCapturedDimensions(buffer, { width: 3840, height: 2160 });

    expect(result.matched).toBe(false);
    expect(result.actualWidth).toBe(1920);
    expect(result.actualHeight).toBe(1080);
    expect(result.requestedWidth).toBe(3840);
  });

  it("throws for bytes that are not a readable image", async () => {
    await expect(verifyCapturedDimensions(Buffer.from("not an image"), { width: 100, height: 100 })).rejects.toThrow();
  });
});
