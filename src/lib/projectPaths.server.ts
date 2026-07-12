import { access, constants, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveCaptureSourcesDataDir, resolveProjectsDataDir } from "./paths.server";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/projectPaths.server.ts touches the filesystem - it must never be imported from a Client Component or run in a browser.",
  );
}

/** Pure - computes where a new project's photo directory would live. Never creates it. */
export function defaultProjectPhotoDirectory(projectId: string) {
  return path.join(resolveProjectsDataDir(), projectId, "photos");
}

/** Pure - computes where a new capture source's directory would live. Never creates it. */
export function defaultCaptureSourceDirectory(captureSourceId: string) {
  return path.join(resolveCaptureSourcesDataDir(), captureSourceId, "source-photos");
}

/**
 * The one place that actually creates a project/capture-source directory.
 * Call this only from code that is about to write a file into `directory`
 * (a capture, an upload, a fan-out derived photo) - never from path
 * resolution, eligibility/status checks, or project/source creation, all
 * of which must stay read-only. See DEPLOYMENT.md / commit history for
 * why: eagerly creating this directory at creation time or on every status
 * poll is what caused data/projects/ to accumulate empty orphan
 * directories for every project ever created (including throwaway test
 * projects), regardless of whether a photo was ever written.
 */
export async function ensureDirectoryExists(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

/**
 * Read-only usability probe - never creates `directory` or any of its
 * ancestors. A directory that doesn't exist yet is considered usable as
 * long as the nearest EXISTING ancestor is writable (walking up past any
 * number of missing levels - e.g. a brand new project's `.../<id>/photos`
 * has neither `<id>` nor `photos` yet, only `data/projects` itself
 * exists), since `ensureDirectoryExists()`'s `mkdir(..., {recursive:
 * true})` will create the whole missing chain later in one call. Only an
 * existing-but-unwritable directory, or a case where no ancestor up to the
 * filesystem root is writable, is reported as unusable. Shared by
 * project/capture-source creation (validate a path without committing to
 * creating it) and capture eligibility checks (which run far more often
 * than an actual capture - see checkCaptureEligibility in
 * captureEligibility.ts).
 */
export async function isDirectoryUsable(directory: string): Promise<boolean> {
  let current = path.resolve(directory);

  for (;;) {
    let stats;
    try {
      stats = await stat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return false;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return false; // reached the filesystem root without finding anything
      }
      current = parent;
      continue;
    }

    if (!stats.isDirectory()) {
      // A file (or something else) is sitting where a directory is needed,
      // either at `directory` itself or at the nearest existing ancestor -
      // mkdir(..., {recursive:true}) would fail either way.
      return false;
    }

    try {
      await access(current, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
