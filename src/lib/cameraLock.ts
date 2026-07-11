import { acquireFileLock, releaseFileLock, CameraBusyError } from "./fileLock";

export { CameraBusyError };

const queueTails = new Map<string, Promise<unknown>>();
const busyDevices = new Set<string>();

export function isCameraBusy(deviceKey: string) {
  return busyDevices.has(deviceKey);
}

export type CameraLockOptions = {
  /** Max time to wait for the cross-process lock before giving up. */
  timeoutMs?: number;
};

/**
 * Serializes work for a given physical camera/device identity, both within
 * this process and across other processes on the same machine (the Next.js
 * app and the separately-running capture service can both call this for the
 * same camera).
 *
 * Layering:
 * 1. An in-process queue orders concurrent calls for the same deviceKey.
 * 2. Once it's a call's turn, it acquires a cross-process file lock before
 *    running fn, and always releases it afterward (finally).
 *
 * A failing job never leaves the device locked, in-process or cross-process:
 * the in-process queue always advances, and the file lock is always
 * released, regardless of whether fn resolved or rejected.
 */
export function withCameraLock<T>(
  deviceKey: string,
  fn: () => Promise<T>,
  options: CameraLockOptions = {},
): Promise<T> {
  const previousTail = queueTails.get(deviceKey) ?? Promise.resolve();

  const run = previousTail.catch(() => undefined).then(async () => {
    busyDevices.add(deviceKey);
    const handle = await acquireFileLock(deviceKey, { timeoutMs: options.timeoutMs });
    try {
      return await fn();
    } finally {
      busyDevices.delete(deviceKey);
      await releaseFileLock(handle);
    }
  });

  queueTails.set(
    deviceKey,
    run.catch(() => undefined),
  );

  return run;
}
