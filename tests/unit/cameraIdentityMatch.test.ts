import { describe, expect, it } from "vitest";
import { matchSavedCamera } from "../../src/lib/cameraIdentityMatch";

describe("matchSavedCamera", () => {
  it("does not attempt a match when no stable id was ever saved", () => {
    const result = matchSavedCamera([{ device: "/dev/video0", stableId: "usb:1:2:abc" }], {
      stableId: null,
      device: "/dev/video0",
    });

    expect(result).toEqual({ matched: null, devicePathChanged: false });
  });

  it("reports no change when the saved stable id is found at the same device path", () => {
    const result = matchSavedCamera([{ device: "/dev/video0", stableId: "usb:1:2:abc" }], {
      stableId: "usb:1:2:abc",
      device: "/dev/video0",
    });

    expect(result.matched).toEqual({ device: "/dev/video0", stableId: "usb:1:2:abc" });
    expect(result.devicePathChanged).toBe(false);
  });

  it("detects a changed /dev/video path for the same physical camera (stable id match)", () => {
    const result = matchSavedCamera([{ device: "/dev/video2", stableId: "usb:1:2:abc" }], {
      stableId: "usb:1:2:abc",
      device: "/dev/video0",
    });

    expect(result.matched).toEqual({ device: "/dev/video2", stableId: "usb:1:2:abc" });
    expect(result.devicePathChanged).toBe(true);
  });

  it("never matches on device path alone when stable ids differ (avoids silently rebinding to a different physical camera)", () => {
    const result = matchSavedCamera([{ device: "/dev/video0", stableId: "usb:9:9:different" }], {
      stableId: "usb:1:2:abc",
      device: "/dev/video0",
    });

    expect(result.matched).toBeNull();
    expect(result.devicePathChanged).toBe(false);
  });

  it("reports no match when the saved camera is not currently connected", () => {
    const result = matchSavedCamera([{ device: "/dev/video0", stableId: "usb:9:9:different" }], {
      stableId: "usb:1:2:abc",
      device: "/dev/video1",
    });

    expect(result.matched).toBeNull();
  });
});
