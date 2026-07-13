/**
 * Runs once when the Next.js server process starts (both `next dev` and
 * `next start`). Logs resolved paths so a misconfigured production
 * deployment (wrong working directory, missing PLANTLAB_ROOT_DIR) is
 * visible in the process's own logs immediately, rather than only
 * surfacing later as a confusing 404/permission error on first camera use.
 *
 * IMPORTANT - do not import src/lib/paths.server.ts (or any other module
 * that touches node:fs/node:path) from this file, even behind the
 * `NEXT_RUNTIME === "nodejs"` guard below. Next.js compiles
 * instrumentation.ts for an edge-compatible webpack target in addition to
 * the nodejs target, and that edge-target compile has no Node builtin
 * resolution at all - it fails on ANY Node builtin import reachable from
 * this file (node:path, bare "path", node:fs/promises), whether static or
 * dynamic, top-level or inside a runtime-guarded dynamic import, and
 * whether the import lives directly in this file or in a module this file
 * imports. That failure blocks the entire dev server (every route 500s),
 * not just instrumentation itself - this exact bug shipped in commit
 * 7096b115. Verified empirically: a plain `import path from "node:path"`
 * with zero other imports in this file reproduces the same
 * UnhandledSchemeError.
 *
 * This file therefore duplicates the tiny amount of root-directory
 * resolution logic it needs (below) rather than sharing
 * resolveRootDir()/logResolvedPaths() from paths.server.ts. Everywhere
 * else in the app (API routes, scripts/camera-service.ts, scripts/*.ts)
 * should keep importing the shared, canonical paths.server.ts - only this
 * one file is restricted this way.
 */
// Inlined from src/lib/suppressExpectedWarnings.ts rather than imported -
// see the file-level comment above on why this file cannot import any
// local module, even a dependency-free one. Keep these two in sync.
const EXPECTED_SQLITE_WARNING = /SQLite is an experimental feature/i;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : undefined;
    const isExperimentalOrUntyped = type === undefined || type === "ExperimentalWarning";
    if (isExperimentalOrUntyped && EXPECTED_SQLITE_WARNING.test(message)) {
      return;
    }
    return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    const override = process.env.PLANTLAB_ROOT_DIR;
    const rootDir = override && override.trim().length > 0 ? override.trim() : process.cwd();

    console.log(
      JSON.stringify({
        level: "info",
        message: "PlantLab web process starting",
        rootDir,
        nodeEnv: process.env.NODE_ENV,
        localCameraHardwareEnabled:
          process.env.NODE_ENV !== "production" ||
          process.env.PLANTLAB_LOCAL_CAMERA_ENABLED === "1" ||
          process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1",
        pid: process.pid,
        time: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error("PlantLab instrumentation startup logging failed:", error);
  }
}
