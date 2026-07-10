const queueTails = new Map<string, Promise<unknown>>();
const busyDevices = new Set<string>();

export function isCameraBusy(deviceKey: string) {
  return busyDevices.has(deviceKey);
}

/**
 * Serializes work for a given physical camera/device identity. Concurrent
 * calls for the same deviceKey queue up and run one at a time, in call
 * order. A failing job never leaves the device locked: the queue always
 * advances regardless of whether the job resolved or rejected.
 */
export function withCameraLock<T>(deviceKey: string, fn: () => Promise<T>): Promise<T> {
  const previousTail = queueTails.get(deviceKey) ?? Promise.resolve();

  const run = previousTail.catch(() => undefined).then(async () => {
    busyDevices.add(deviceKey);
    try {
      return await fn();
    } finally {
      busyDevices.delete(deviceKey);
    }
  });

  queueTails.set(
    deviceKey,
    run.catch(() => undefined),
  );

  return run;
}
