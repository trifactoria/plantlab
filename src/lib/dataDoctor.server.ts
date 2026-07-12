import { lstat, readdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { resolveProjectsDataDir } from "./paths.server";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/dataDoctor.server.ts touches the filesystem - it must never be imported from a Client Component or run in a browser.",
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_MIN_ORPHAN_AGE_MS = 60 * 60 * 1000; // one hour

export type DirectoryEntryAudit = {
  id: string;
  directoryPath: string;
  isSymlink: boolean;
  looksLikeProjectId: boolean;
  fileCount: number;
  totalBytes: number;
  mtime: Date;
};

export type ProjectDirectoryReport = {
  dataRoot: string;
  projectsDataDir: string;
  totalDbProjects: number;
  expectedDirectories: Array<{ projectId: string; directoryPath: string }>;
  existingDirectoryNames: string[];
  missingExpectedDirectories: Array<{ projectId: string; directoryPath: string }>;
  emptyOrphans: DirectoryEntryAudit[];
  nonEmptyOrphans: DirectoryEntryAudit[];
  malformedNames: DirectoryEntryAudit[];
  symlinks: DirectoryEntryAudit[];
};

/** Recursively counts real files and total bytes under `dir` (symlinks inside are not followed for size purposes). */
async function walkDirectoryStats(dir: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += (await stat(entryPath)).size;
      }
      // Symlinks nested inside are neither followed nor counted - they don't
      // make a directory "non-empty" for cleanup purposes on their own, and
      // this function is never called on a directory we're about to delete
      // without also having checked isSymlink on it directly.
    }
  }

  await walk(dir);
  return { fileCount, totalBytes };
}

/**
 * Compares the canonical SQLite Project table against the immediate
 * subdirectories of the configured projects-data root. Read-only - never
 * creates, modifies, or deletes anything.
 *
 * Orphan classification is based on the directory's basename matching a
 * current Project.id, not on string-matching against
 * Project.localPhotoDirectory (which a user may have customized to point
 * anywhere) - see removeEmptyOrphans() for why this matters for cleanup
 * safety.
 */
export async function auditProjectDirectories(prisma: PrismaClient): Promise<ProjectDirectoryReport> {
  const projectsDataDir = resolveProjectsDataDir();
  const projects = await prisma.project.findMany({ select: { id: true, localPhotoDirectory: true } });
  const projectIds = new Set(projects.map((p) => p.id));

  const expectedDirectories = projects.map((p) => ({
    projectId: p.id,
    directoryPath: path.join(projectsDataDir, p.id),
  }));

  let entryNames: string[] = [];
  try {
    const entries = await readdir(projectsDataDir, { withFileTypes: true });
    entryNames = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // The projects-data root doesn't exist yet at all - nothing to report.
  }

  const missingExpectedDirectories: ProjectDirectoryReport["missingExpectedDirectories"] = [];
  for (const expected of expectedDirectories) {
    if (!entryNames.includes(expected.projectId)) {
      missingExpectedDirectories.push(expected);
    }
  }

  const emptyOrphans: DirectoryEntryAudit[] = [];
  const nonEmptyOrphans: DirectoryEntryAudit[] = [];
  const malformedNames: DirectoryEntryAudit[] = [];
  const symlinks: DirectoryEntryAudit[] = [];

  for (const name of entryNames) {
    const directoryPath = path.join(projectsDataDir, name);
    const stats = await lstat(directoryPath);
    const isSymlink = stats.isSymbolicLink();
    const looksLikeProjectId = UUID_RE.test(name);
    const isKnownProject = projectIds.has(name);

    if (isSymlink) {
      symlinks.push({
        id: name,
        directoryPath,
        isSymlink: true,
        looksLikeProjectId,
        fileCount: 0,
        totalBytes: 0,
        mtime: stats.mtime,
      });
      continue; // symlinks are always reported separately and never touched by cleanup
    }

    if (isKnownProject) {
      continue; // not an orphan, regardless of contents
    }

    const { fileCount, totalBytes } = await walkDirectoryStats(directoryPath);
    const entry: DirectoryEntryAudit = {
      id: name,
      directoryPath,
      isSymlink: false,
      looksLikeProjectId,
      fileCount,
      totalBytes,
      mtime: stats.mtime,
    };

    if (!looksLikeProjectId) {
      malformedNames.push(entry);
    }

    if (fileCount === 0) {
      emptyOrphans.push(entry);
    } else {
      nonEmptyOrphans.push(entry);
    }
  }

  return {
    dataRoot: path.dirname(projectsDataDir),
    projectsDataDir,
    totalDbProjects: projects.length,
    expectedDirectories,
    existingDirectoryNames: entryNames,
    missingExpectedDirectories,
    emptyOrphans,
    nonEmptyOrphans,
    malformedNames,
    symlinks,
  };
}

export type RemoveEmptyOrphansOptions = {
  /** Minimum age (by mtime) required before an empty orphan is eligible for removal. Defaults to one hour. */
  minAgeMs?: number;
  /** Explicit override to skip the age check entirely - only pass this when the caller has deliberately opted in (e.g. a CLI flag), never by default. */
  ignoreAge?: boolean;
  now?: Date;
};

export type RemoveEmptyOrphansResult = {
  removed: string[];
  skipped: Array<{ directoryPath: string; reason: string }>;
};

/**
 * Removes `directoryPath` only if it and every directory nested inside it
 * contain zero files and zero symlinks anywhere in the subtree (re-checked
 * fresh right here, not trusting an earlier audit snapshot). A project
 * directory that used the old eager-mkdir behavior typically contains one
 * empty `photos` subdirectory and nothing else - a plain `rmdir()` on the
 * outer directory alone fails with ENOTEMPTY for exactly that shape, so
 * this walks and removes empty subdirectories bottom-up instead. The
 * moment a file or symlink is found anywhere in the subtree, the entire
 * operation aborts without deleting anything (not even the empty
 * subdirectories already visited).
 */
async function removeIfEntirelyEmpty(directoryPath: string): Promise<{ removed: boolean; reason?: string }> {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      return { removed: false, reason: `Contains a symlink (${entryPath}) - preserved` };
    }
    if (entry.isFile()) {
      return { removed: false, reason: `Contains a file (${entryPath}) - no longer empty` };
    }
    if (entry.isDirectory()) {
      const nested = await removeIfEntirelyEmpty(entryPath);
      if (!nested.removed) {
        return nested;
      }
    }
  }

  await rmdir(directoryPath);
  return { removed: true };
}

/**
 * Deletes only empty orphan directories that are immediate children of the
 * configured projects-data root, real directories (never symlinks - see
 * auditProjectDirectories, which reports symlinks separately and excludes
 * them from the orphan lists entirely), contain no files anywhere in their
 * subtree, are not referenced by any current Project.id, and are older
 * than the safety interval. Never touches a non-empty orphan.
 */
export async function removeEmptyOrphans(
  report: ProjectDirectoryReport,
  options: RemoveEmptyOrphansOptions = {},
): Promise<RemoveEmptyOrphansResult> {
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_ORPHAN_AGE_MS;
  const now = options.now ?? new Date();
  const removed: string[] = [];
  const skipped: Array<{ directoryPath: string; reason: string }> = [];

  for (const orphan of report.emptyOrphans) {
    const ageMs = now.getTime() - orphan.mtime.getTime();
    if (!options.ignoreAge && ageMs < minAgeMs) {
      skipped.push({
        directoryPath: orphan.directoryPath,
        reason: `Too recent (age ${Math.round(ageMs / 1000)}s < ${Math.round(minAgeMs / 1000)}s safety interval)`,
      });
      continue;
    }

    // Re-verify immediately before deleting - defends against a file being
    // written into this directory between the audit and this call.
    const currentStats = await lstat(orphan.directoryPath).catch(() => null);
    if (!currentStats || currentStats.isSymbolicLink()) {
      skipped.push({ directoryPath: orphan.directoryPath, reason: "No longer a plain directory" });
      continue;
    }

    try {
      const result = await removeIfEntirelyEmpty(orphan.directoryPath);
      if (result.removed) {
        removed.push(orphan.directoryPath);
      } else {
        skipped.push({ directoryPath: orphan.directoryPath, reason: result.reason ?? "Not empty" });
      }
    } catch (error) {
      skipped.push({
        directoryPath: orphan.directoryPath,
        reason: `Could not remove: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { removed, skipped };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
