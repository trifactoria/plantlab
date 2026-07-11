import { describe, expect, it } from "vitest";
import {
  buildSharpResizeOptions,
  buildCropThumbnailUrl,
  computeExtractRegion,
  DEFAULT_THUMBNAIL_SIZE,
  MAX_THUMBNAIL_SIZE,
  resolveThumbnailResizeRequest,
  resolveThumbnailSize,
} from "../../src/lib/cropThumbnail";

describe("computeExtractRegion", () => {
  it("converts a centered normalized crop into source pixels", () => {
    const region = computeExtractRegion({ cropX: 0.25, cropY: 0.25, cropWidth: 0.5, cropHeight: 0.5 }, 400, 200);
    expect(region).toEqual({ left: 100, top: 50, width: 200, height: 100 });
  });

  it("clamps a crop that would run past the right/bottom edge due to rounding", () => {
    // 0.9 + 0.2 > 1, so the raw pixel width would overflow the image bounds.
    const region = computeExtractRegion({ cropX: 0.9, cropY: 0.9, cropWidth: 0.2, cropHeight: 0.2 }, 100, 100);
    expect(region.left).toBeLessThanOrEqual(99);
    expect(region.top).toBeLessThanOrEqual(99);
    expect(region.left + region.width).toBeLessThanOrEqual(100);
    expect(region.top + region.height).toBeLessThanOrEqual(100);
  });

  it("handles a crop that fills the entire photo", () => {
    const region = computeExtractRegion({ cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1 }, 640, 480);
    expect(region).toEqual({ left: 0, top: 0, width: 640, height: 480 });
  });

  it("never produces a negative left/top even at the extreme corner", () => {
    const region = computeExtractRegion({ cropX: 0, cropY: 0, cropWidth: 0.01, cropHeight: 0.01 }, 50, 50);
    expect(region.left).toBeGreaterThanOrEqual(0);
    expect(region.top).toBeGreaterThanOrEqual(0);
    expect(region.width).toBeGreaterThan(0);
    expect(region.height).toBeGreaterThan(0);
  });
});

describe("resolveThumbnailSize", () => {
  it("falls back to the default when missing or invalid", () => {
    expect(resolveThumbnailSize(null)).toBe(DEFAULT_THUMBNAIL_SIZE);
    expect(resolveThumbnailSize("not-a-number")).toBe(DEFAULT_THUMBNAIL_SIZE);
    expect(resolveThumbnailSize("-50")).toBe(DEFAULT_THUMBNAIL_SIZE);
    expect(resolveThumbnailSize("0")).toBe(DEFAULT_THUMBNAIL_SIZE);
  });

  it("uses the requested size when valid", () => {
    expect(resolveThumbnailSize("320")).toBe(320);
  });

  it("clamps to the maximum allowed size", () => {
    expect(resolveThumbnailSize(String(MAX_THUMBNAIL_SIZE + 5000))).toBe(MAX_THUMBNAIL_SIZE);
  });
});

describe("thumbnail resize options", () => {
  it("derives width-only output without forcing height", () => {
    expect(buildSharpResizeOptions(resolveThumbnailResizeRequest(new URLSearchParams("width=320")))).toEqual({
      width: 320,
      height: undefined,
      fit: undefined,
      withoutEnlargement: true,
    });
  });

  it("derives height-only output without forcing width", () => {
    expect(buildSharpResizeOptions(resolveThumbnailResizeRequest(new URLSearchParams("height=180")))).toEqual({
      width: undefined,
      height: 180,
      fit: undefined,
      withoutEnlargement: true,
    });
  });

  it("uses inside fit when both bounds are supplied, never fill", () => {
    expect(buildSharpResizeOptions(resolveThumbnailResizeRequest(new URLSearchParams("maxWidth=320&maxHeight=180")))).toEqual({
      width: 320,
      height: 180,
      fit: "inside",
      withoutEnlargement: true,
    });
  });
});

describe("buildCropThumbnailUrl", () => {
  it("embeds the crop id, size, and an updatedAt-derived cache-busting version", () => {
    const updatedAt = new Date("2026-07-10T12:00:00Z");
    const url = buildCropThumbnailUrl({ id: "crop-1", updatedAt }, { size: 240 });

    expect(url).toBe(`/api/plant-photo-crops/crop-1/thumbnail?size=240&v=${updatedAt.getTime()}`);
  });

  it("produces a different URL when the crop is updated (cache-busting)", () => {
    const first = buildCropThumbnailUrl({ id: "crop-1", updatedAt: new Date("2026-07-10T12:00:00Z") });
    const second = buildCropThumbnailUrl({ id: "crop-1", updatedAt: new Date("2026-07-10T12:05:00Z") });

    expect(first).not.toBe(second);
  });
});
