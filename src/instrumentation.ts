/**
 * Runs once when the Next.js server process starts (both `next dev` and
 * `next start`). Logs resolved paths so a misconfigured production
 * deployment (wrong working directory, missing PLANTLAB_ROOT_DIR) is
 * visible in the process's own logs immediately, rather than only
 * surfacing later as a confusing 404/permission error on first camera use.
 * Never throws - a path-logging failure must not prevent the web app
 * (which also serves everything unrelated to cameras) from starting.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { logResolvedPaths } = await import("./lib/paths");
  const { localCameraHardwareEnabled } = await import("./lib/localOnly");

  try {
    logResolvedPaths();
    console.log(
      JSON.stringify({
        level: "info",
        message: "PlantLab web process starting",
        nodeEnv: process.env.NODE_ENV,
        localCameraHardwareEnabled: localCameraHardwareEnabled(),
        pid: process.pid,
        time: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error("PlantLab instrumentation startup logging failed:", error);
  }
}
