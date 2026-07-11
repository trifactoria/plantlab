import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, nextCapturePath } from "../../src/lib/camera";

const baseSettings = {
  device: "/dev/video0",
  width: 1920,
  height: 1080,
  inputFormat: "mjpg",
};

describe("buildFfmpegArgs", () => {
  it("requests a single frame with no warm-up duration by default", () => {
    const args = buildFfmpegArgs(baseSettings, "/tmp/out.jpg");

    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("1");
  });

  it("extends duration by warmupSeconds + 1 when warming up", () => {
    const args = buildFfmpegArgs(baseSettings, "/tmp/out.jpg", { warmup: true, warmupSeconds: 5 });

    expect(args[args.indexOf("-t") + 1]).toBe("6");
  });

  it("keeps overwriting a single output file instead of writing a sequence or video", () => {
    const args = buildFfmpegArgs(baseSettings, "/tmp/out.jpg", { warmup: true, warmupSeconds: 3 });

    // -update 1 (image2 muxer overwrite mode) is what makes warm-up frames
    // get discarded in place rather than accumulating as frame0001.jpg, etc.
    expect(args[args.indexOf("-update") + 1]).toBe("1");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=1");
    // The very last argument is the single still-image output path - no
    // separate video container is ever requested.
    expect(args.at(-1)).toBe("/tmp/out.jpg");
  });

  it("normalizes the mjpg alias to ffmpeg's mjpeg input format", () => {
    const args = buildFfmpegArgs(baseSettings, "/tmp/out.jpg");

    expect(args[args.indexOf("-input_format") + 1]).toBe("mjpeg");
  });

  it("passes through non-mjpg input formats unchanged", () => {
    const args = buildFfmpegArgs({ ...baseSettings, inputFormat: "yuyv422" }, "/tmp/out.jpg");

    expect(args[args.indexOf("-input_format") + 1]).toBe("yuyv422");
  });

  it("encodes the requested device and resolution", () => {
    const args = buildFfmpegArgs(baseSettings, "/tmp/out.jpg");

    expect(args[args.indexOf("-i") + 1]).toBe("/dev/video0");
    expect(args[args.indexOf("-video_size") + 1]).toBe("1920x1080");
  });
});

describe("nextCapturePath", () => {
  it("uses a timestamped filename derived from the captured moment", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "plantlab-camera-test-"));
    const capturedAt = new Date("2026-07-10T13:30:00");

    const candidate = await nextCapturePath(directory, capturedAt);

    expect(path.dirname(candidate)).toBe(directory);
    expect(path.basename(candidate)).toMatch(/^2026-07-10_13-30-00\.jpg$/);
  });

  it("de-duplicates by appending a numeric suffix when the timestamped path is already taken", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "plantlab-camera-test-"));
    const capturedAt = new Date("2026-07-10T13:30:00");

    const first = await nextCapturePath(directory, capturedAt);
    await writeFile(first, "existing frame");

    const second = await nextCapturePath(directory, capturedAt);

    expect(second).not.toBe(first);
    expect(path.basename(second)).toBe("2026-07-10_13-30-00-1.jpg");
  });
});
