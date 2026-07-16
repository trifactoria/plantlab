import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImageValidationError, validateImageBuffer } from "../../src/lib/imageValidation";

function texturedRaw(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const texture = (x * 17 + y * 31 + ((x * y) % 53)) % 80;
      data[index] = 70 + texture;
      data[index + 1] = 95 + ((texture + x) % 95);
      data[index + 2] = 55 + ((texture + y) % 70);
    }
  }
  return data;
}

async function jpegFromRaw(data: Buffer, width: number, height: number) {
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function healthyFrame(width = 320, height = 180) {
  return jpegFromRaw(texturedRaw(width, height), width, height);
}

async function horizontalPartialFrame(width = 320, height = 180) {
  const data = texturedRaw(width, height);
  for (let y = Math.floor(height * 0.34); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      data[index] = Math.min(255, data[index] + 75);
      data[index + 1] = Math.min(255, data[index + 1] + 110);
      data[index + 2] = Math.max(0, data[index + 2] - 35);
    }
  }
  return jpegFromRaw(data, width, height);
}

async function verticalChannelFrame(width = 320, height = 180) {
  const data = texturedRaw(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.floor(width * 0.52); x < width; x += 1) {
      const index = (y * width + x) * 3;
      data[index] = Math.max(0, data[index] - 45);
      data[index + 1] = Math.min(255, data[index + 1] + 95);
      data[index + 2] = Math.max(0, data[index + 2] - 30);
    }
  }
  return jpegFromRaw(data, width, height);
}

async function quadrantCorruptionFrame(width = 320, height = 180) {
  const data = texturedRaw(width, height);
  for (let y = Math.floor(height / 2); y < height; y += 1) {
    for (let x = Math.floor(width / 2); x < width; x += 1) {
      const index = (y * width + x) * 3;
      data[index] = Math.min(255, data[index] + 100);
      data[index + 1] = Math.min(255, data[index + 1] + 120);
      data[index + 2] = Math.max(0, data[index + 2] - 50);
    }
  }
  return jpegFromRaw(data, width, height);
}

describe("image validation", () => {
  it("accepts a textured camera frame", async () => {
    const image = await healthyFrame();
    await expect(validateImageBuffer(image, { expectedWidth: 320, expectedHeight: 180, expectedFormat: "jpeg" })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects a horizontal partial-frame discontinuity", async () => {
    const image = await horizontalPartialFrame();
    await expect(validateImageBuffer(image, { expectedWidth: 320, expectedHeight: 180, expectedFormat: "jpeg" })).rejects.toMatchObject({
      code: "partial-frame",
      stats: expect.objectContaining({
        horizontalSplitChannelDelta: expect.any(Number),
      }),
    } satisfies Partial<ImageValidationError>);
  });

  it("rejects a vertical channel discontinuity", async () => {
    const image = await verticalChannelFrame();
    await expect(validateImageBuffer(image, { expectedWidth: 320, expectedHeight: 180, expectedFormat: "jpeg" })).rejects.toMatchObject({
      code: "partial-frame",
      stats: expect.objectContaining({
        verticalSplitChannelDelta: expect.any(Number),
      }),
    } satisfies Partial<ImageValidationError>);
  });

  it("rejects quadrant replacement as split-frame corruption", async () => {
    const image = await quadrantCorruptionFrame();
    await expect(validateImageBuffer(image, { expectedWidth: 320, expectedHeight: 180, expectedFormat: "jpeg" })).rejects.toMatchObject({
      code: "partial-frame",
    } satisfies Partial<ImageValidationError>);
  });
});
