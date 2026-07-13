import { describe, expect, it } from "vitest";
import { findCameraMode, normalizeCameraInputFormat, preferredCameraMode, type CameraFormat } from "../../src/lib/cameraModes";

const bokchoyFormats: CameraFormat[] = [
  {
    pixelFormat: "mjpeg",
    description: "Motion-JPEG",
    resolutions: [
      { width: 1280, height: 720, frameRates: ["30.000 fps"] },
      { width: 848, height: 480, frameRates: ["30.000 fps"] },
      { width: 960, height: 540, frameRates: ["30.000 fps"] },
    ],
  },
  {
    pixelFormat: "yuyv422",
    description: "YUYV 4:2:2",
    resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
  },
];

describe("camera mode helpers", () => {
  it("normalizes V4L2 FourCC aliases to the FFmpeg input names PlantLab stores", () => {
    expect(normalizeCameraInputFormat("MJPG")).toBe("mjpeg");
    expect(normalizeCameraInputFormat("JPEG")).toBe("mjpeg");
    expect(normalizeCameraInputFormat("YUYV")).toBe("yuyv422");
  });

  it("prefers MJPEG over uncompressed formats at the highest advertised practical resolution", () => {
    expect(preferredCameraMode(bokchoyFormats)).toMatchObject({ inputFormat: "mjpeg", width: 1280, height: 720 });
  });

  it("finds only advertised format-resolution tuples and does not synthesize cross-format combinations", () => {
    expect(findCameraMode(bokchoyFormats, "mjpeg", 1280, 720)).toBeTruthy();
    expect(findCameraMode(bokchoyFormats, "yuyv422", 640, 480)).toBeTruthy();
    expect(findCameraMode(bokchoyFormats, "mjpeg", 640, 480)).toBeNull();
  });
});
