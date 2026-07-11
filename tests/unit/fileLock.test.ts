import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock, CameraBusyError, releaseFileLock } from "../../src/lib/fileLock";

// Mirrors fileLock.ts's internal (unexported) path scheme so tests can
// pre-write lock files to exercise stale-recovery without real hardware.
const RUNTIME_DIR = path.join(process.cwd(), "data", "runtime", "locks");
function lockPathFor(key: string) {
  return path.join(RUNTIME_DIR, `camera-${key}.lock`);
}

function testKey() {
  return `vitest-${randomUUID()}`;
}

describe("acquireFileLock / releaseFileLock", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const lockPath of cleanupPaths.splice(0)) {
      await rm(lockPath, { force: true });
    }
  });

  it("serializes cross-process contention: a second acquire waits until the first releases", async () => {
    const key = testKey();
    cleanupPaths.push(lockPathFor(key));

    const handle1 = await acquireFileLock(key, { timeoutMs: 3_000 });

    const order: string[] = [];
    const second = acquireFileLock(key, { timeoutMs: 3_000 }).then((handle2) => {
      order.push("second-acquired");
      return handle2;
    });

    // Give the second attempt a chance to start polling and confirm it's
    // still blocked while the first lock is held.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);

    order.push("releasing-first");
    await releaseFileLock(handle1);

    const handle2 = await second;
    expect(order).toEqual(["releasing-first", "second-acquired"]);

    await releaseFileLock(handle2);
  });

  it("reports a clear busy error when the lock cannot be acquired before the timeout", async () => {
    const key = testKey();
    cleanupPaths.push(lockPathFor(key));

    const handle1 = await acquireFileLock(key, { timeoutMs: 3_000 });

    await expect(acquireFileLock(key, { timeoutMs: 300 })).rejects.toThrow(CameraBusyError);
    await expect(acquireFileLock(key, { timeoutMs: 300 })).rejects.toThrow(/currently busy/);

    await releaseFileLock(handle1);
  });

  it("recovers a stale lock left behind by a process that is no longer running", async () => {
    const key = testKey();
    const lockPath = lockPathFor(key);
    cleanupPaths.push(lockPath);

    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999_999, // essentially guaranteed not to be a live process
        hostname: "stale-host",
        token: "stale-token",
        acquiredAt: new Date().toISOString(),
      }),
    );

    const handle = await acquireFileLock(key, { timeoutMs: 2_000 });
    expect(handle.path).toBe(lockPath);
    await releaseFileLock(handle);
  });

  it("recovers a stale lock that has simply been held too long, even if its pid is alive", async () => {
    const key = testKey();
    const lockPath = lockPathFor(key);
    cleanupPaths.push(lockPath);

    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid, // our own test process - genuinely alive
        hostname: "old-host",
        token: "old-token",
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    const handle = await acquireFileLock(key, { timeoutMs: 2_000, staleAfterMs: 100 });
    expect(handle.path).toBe(lockPath);
    await releaseFileLock(handle);
  });

  it("never leaves the device permanently locked after a release", async () => {
    const key = testKey();
    cleanupPaths.push(lockPathFor(key));

    const handle1 = await acquireFileLock(key, { timeoutMs: 2_000 });
    await releaseFileLock(handle1);

    // Immediately re-acquirable - release is not itself getting stuck.
    const handle2 = await acquireFileLock(key, { timeoutMs: 2_000 });
    await releaseFileLock(handle2);
  });
});
