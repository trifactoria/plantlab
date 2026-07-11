import { describe, expect, it } from "vitest";
import { cropData, cropFromBody, eventHasCrop, validateCrop } from "../../src/lib/crops";

describe("validateCrop", () => {
  it("accepts a well-formed normalized crop", () => {
    expect(() => validateCrop({ cropX: 0.1, cropY: 0.2, cropWidth: 0.3, cropHeight: 0.4 })).not.toThrow();
  });

  it("accepts a crop that exactly fills the photo", () => {
    expect(() => validateCrop({ cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1 })).not.toThrow();
  });

  it("allows null (no crop)", () => {
    expect(() => validateCrop(null)).not.toThrow();
  });

  it("rejects non-finite values", () => {
    expect(() => validateCrop({ cropX: Number.NaN, cropY: 0, cropWidth: 0.1, cropHeight: 0.1 })).toThrow(
      /finite/,
    );
    expect(() =>
      validateCrop({ cropX: 0, cropY: Number.POSITIVE_INFINITY, cropWidth: 0.1, cropHeight: 0.1 }),
    ).toThrow(/finite/);
  });

  it("rejects negative x or y", () => {
    expect(() => validateCrop({ cropX: -0.01, cropY: 0, cropWidth: 0.1, cropHeight: 0.1 })).toThrow(
      /zero or greater/,
    );
    expect(() => validateCrop({ cropX: 0, cropY: -0.5, cropWidth: 0.1, cropHeight: 0.1 })).toThrow(
      /zero or greater/,
    );
  });

  it("rejects zero or negative width/height", () => {
    expect(() => validateCrop({ cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0.1 })).toThrow(
      /greater than zero/,
    );
    expect(() => validateCrop({ cropX: 0, cropY: 0, cropWidth: 0.1, cropHeight: -0.1 })).toThrow(
      /greater than zero/,
    );
  });

  it("rejects a crop that extends past the right or bottom edge", () => {
    expect(() => validateCrop({ cropX: 0.6, cropY: 0, cropWidth: 0.5, cropHeight: 0.1 })).toThrow(
      /fit inside/,
    );
    expect(() => validateCrop({ cropX: 0, cropY: 0.9, cropWidth: 0.1, cropHeight: 0.2 })).toThrow(
      /fit inside/,
    );
  });
});

describe("cropFromBody", () => {
  it("returns undefined when no crop fields are present", () => {
    expect(cropFromBody({})).toBeUndefined();
    expect(cropFromBody(null)).toBeUndefined();
  });

  it("returns null when all crop fields are explicitly null", () => {
    expect(
      cropFromBody({ cropX: null, cropY: null, cropWidth: null, cropHeight: null }),
    ).toBeNull();
  });

  it("returns a validated crop when all fields are present", () => {
    const crop = cropFromBody({ cropX: "0.1", cropY: 0.2, cropWidth: 0.3, cropHeight: 0.4 });
    expect(crop).toEqual({ cropX: 0.1, cropY: 0.2, cropWidth: 0.3, cropHeight: 0.4 });
  });

  it("throws when only some crop fields are present", () => {
    expect(() => cropFromBody({ cropX: 0.1, cropY: 0.2 })).toThrow(/must include/);
  });

  it("throws when the provided values are out of bounds", () => {
    expect(() => cropFromBody({ cropX: 0.9, cropY: 0.9, cropWidth: 0.5, cropHeight: 0.5 })).toThrow(
      /fit inside/,
    );
  });
});

describe("cropData", () => {
  it("returns an empty object for undefined (no change)", () => {
    expect(cropData(undefined)).toEqual({});
  });

  it("returns explicit nulls for null (clear the crop)", () => {
    expect(cropData(null)).toEqual({
      cropX: null,
      cropY: null,
      cropWidth: null,
      cropHeight: null,
    });
  });

  it("passes a crop object through unchanged", () => {
    const crop = { cropX: 0.1, cropY: 0.1, cropWidth: 0.2, cropHeight: 0.2 };
    expect(cropData(crop)).toEqual(crop);
  });
});

describe("eventHasCrop", () => {
  it("is true only when every crop field is non-null", () => {
    expect(
      eventHasCrop({ cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1 }),
    ).toBe(true);
    expect(
      eventHasCrop({ cropX: null, cropY: 0, cropWidth: 1, cropHeight: 1 }),
    ).toBe(false);
    expect(
      eventHasCrop({ cropX: null, cropY: null, cropWidth: null, cropHeight: null }),
    ).toBe(false);
  });
});
