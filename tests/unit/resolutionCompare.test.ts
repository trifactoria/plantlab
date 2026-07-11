import { describe, expect, it } from "vitest";
import { compareResolutions, supportedCandidateResolutions } from "../../src/lib/resolutionCompare";
import type { CameraFormat } from "../../src/lib/v4l2";

describe("supportedCandidateResolutions", () => {
  it("only offers candidates the camera actually reports for the given format", () => {
    const formats: CameraFormat[] = [
      {
        pixelFormat: "mjpg",
        description: "Motion-JPEG",
        resolutions: [
          { width: 1920, height: 1080, frameRates: [] },
          { width: 3840, height: 2160, frameRates: [] },
        ],
      },
    ];

    const candidates = supportedCandidateResolutions(formats, "mjpg");

    expect(candidates).toEqual([
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 },
    ]);
  });

  it("returns nothing when the pixel format itself is unsupported", () => {
    const formats: CameraFormat[] = [
      { pixelFormat: "yuyv", description: "YUYV", resolutions: [{ width: 640, height: 480, frameRates: [] }] },
    ];

    expect(supportedCandidateResolutions(formats, "mjpg")).toEqual([]);
  });
});

describe("compareResolutions", () => {
  it("captures each candidate sequentially, never opening the camera at two resolutions at once", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const capture = async (width: number, height: number) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`${width}x${height}-start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${width}x${height}-end`);
      concurrent -= 1;
      return Buffer.from(`fake-${width}x${height}`);
    };

    const results = await compareResolutions(
      [
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
      ],
      capture,
    );

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(["1920x1080-start", "1920x1080-end", "2560x1440-start", "2560x1440-end"]);

    expect(results).toHaveLength(2);
    expect(results[0].width).toBe(1920);
    expect(results[0].height).toBe(1080);
    expect(results[0].byteSize).toBe(Buffer.from("fake-1920x1080").length);
    expect(results[0].imageBase64).toBe(Buffer.from("fake-1920x1080").toString("base64"));
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns no results for an empty candidate list without calling capture", async () => {
    let called = false;
    const results = await compareResolutions([], async () => {
      called = true;
      return Buffer.from("");
    });

    expect(called).toBe(false);
    expect(results).toEqual([]);
  });
});
