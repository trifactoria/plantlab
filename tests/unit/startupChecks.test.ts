import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkExecutable,
  checkVideoDevices,
  checkWritableDirectory,
  formatCheckLine,
  summarizeChecks,
} from "../../src/lib/startupChecks";

describe("checkExecutable", () => {
  it("passes and reports a resolved path for an executable known to exist", async () => {
    // `sh` is required to exist on any POSIX system this could run on.
    const result = await checkExecutable("sh", true);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Found at");
  });

  it("fails with a clear, actionable message for a missing required executable", async () => {
    const result = await checkExecutable("plantlab-definitely-not-a-real-binary", true);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("plantlab-definitely-not-a-real-binary");
    expect(result.detail).toContain("was not found on PATH");
  });

  it("warns (not fails) for a missing optional executable", async () => {
    const result = await checkExecutable("plantlab-definitely-not-a-real-binary-2", false);
    expect(result.status).toBe("warn");
  });
});

describe("checkWritableDirectory", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("passes and creates the directory if it doesn't exist yet", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "plantlab-writable-test-"));
    created.push(parent);
    const target = path.join(parent, "nested", "dir");

    const result = await checkWritableDirectory("test-dir", target);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(target);
  });

  it("fails when the path is a file, not a directory", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "plantlab-writable-test-"));
    created.push(parent);
    const filePath = path.join(parent, "not-a-directory");
    await writeFile(filePath, "x");

    const result = await checkWritableDirectory("test-dir", filePath);
    expect(result.status).toBe("fail");
  });
});

describe("checkVideoDevices", () => {
  it("returns a result without throwing regardless of whether /dev/video* devices are present", async () => {
    const result = await checkVideoDevices();
    expect(["pass", "warn", "fail"]).toContain(result.status);
    expect(result.name).toBe("video-devices");
  });
});

describe("summarizeChecks", () => {
  it("is ok only when there are zero failures, regardless of warnings", () => {
    expect(summarizeChecks([{ name: "a", status: "pass", detail: "" }, { name: "b", status: "warn", detail: "" }])).toEqual({
      ok: true,
      failCount: 0,
      warnCount: 1,
    });
    expect(summarizeChecks([{ name: "a", status: "fail", detail: "" }])).toEqual({
      ok: false,
      failCount: 1,
      warnCount: 0,
    });
  });
});

describe("formatCheckLine", () => {
  it("includes a bracketed status tag and the detail message", () => {
    expect(formatCheckLine({ name: "ffmpeg", status: "pass", detail: "Found at /usr/bin/ffmpeg" })).toBe(
      "[PASS] ffmpeg: Found at /usr/bin/ffmpeg",
    );
    expect(formatCheckLine({ name: "ffmpeg", status: "fail", detail: "missing" })).toBe("[FAIL] ffmpeg: missing");
  });
});
