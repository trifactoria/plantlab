import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeLocksDir } from "./paths.server";

export class CameraBusyError extends Error {
  constructor(
    message: string,
    public readonly holder?: LockFileContents | null,
  ) {
    super(message);
    this.name = "CameraBusyError";
  }
}

export type FileLockHandle = {
  path: string;
  token: string;
};

type LockFileContents = {
  pid: number;
  hostname: string;
  token: string;
  acquiredAt: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const RETRY_DELAY_MS = 150;

function sanitizeLockKey(key: string) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function lockPathFor(key: string) {
  return path.join(resolveRuntimeLocksDir(), `camera-${sanitizeLockKey(key)}.lock`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A process is considered alive if signalling it doesn't fail with ESRCH.
 * EPERM means the process exists but is owned by someone else - still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockHolder(lockPath: string): Promise<LockFileContents | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return JSON.parse(raw) as LockFileContents;
  } catch {
    return null;
  }
}

/**
 * Returns true if the existing lock was removed (caller should retry
 * acquiring it), false if it's still validly held by a live process.
 */
async function tryReclaimStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  const holder = await readLockHolder(lockPath);

  if (!holder) {
    // Missing or corrupt lock file contents - safe to clear and retry.
    await unlink(lockPath).catch(() => undefined);
    return true;
  }

  const ageMs = Date.now() - new Date(holder.acquiredAt).getTime();
  const stale = ageMs > staleAfterMs || !isProcessAlive(holder.pid);

  if (stale) {
    await unlink(lockPath).catch(() => undefined);
    return true;
  }

  return false;
}

/**
 * Acquires a cross-process lock for the given key (a camera device path or
 * stable camera identity) using an exclusively-created lock file as the
 * mutex. Safe across the Next.js app process and the separate capture
 * service process on the same machine. No external services required.
 */
export async function acquireFileLock(
  key: string,
  options: { timeoutMs?: number; staleAfterMs?: number } = {},
): Promise<FileLockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const lockPath = lockPathFor(key);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  await mkdir(resolveRuntimeLocksDir(), { recursive: true });

  for (;;) {
    const contents: LockFileContents = {
      pid: process.pid,
      hostname: os.hostname(),
      token,
      acquiredAt: new Date().toISOString(),
    };

    try {
      await writeFile(lockPath, JSON.stringify(contents), { flag: "wx" });
      return { path: lockPath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const reclaimed = await tryReclaimStaleLock(lockPath, staleAfterMs);
      if (reclaimed) {
        continue;
      }

      if (Date.now() >= deadline) {
        const holder = await readLockHolder(lockPath);
        const holderDescription = holder
          ? ` (held by pid ${holder.pid} on ${holder.hostname} since ${holder.acquiredAt})`
          : "";
        throw new CameraBusyError(
          `Camera "${key}" is currently busy${holderDescription}. Try again shortly.`,
          holder,
        );
      }

      await delay(RETRY_DELAY_MS);
    }
  }
}

/** Releases a lock only if it still belongs to this handle's token. */
export async function releaseFileLock(handle: FileLockHandle): Promise<void> {
  const holder = await readLockHolder(handle.path);

  if (!holder || holder.token === handle.token) {
    await unlink(handle.path).catch(() => undefined);
  }
  // If the token doesn't match, another process already reclaimed this
  // lock as stale and holds it now - it is not ours to remove.
}
