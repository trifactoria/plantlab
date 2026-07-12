import path from "node:path";

/**
 * The PlantLab repository/install root. Every data, photo, capture,
 * backup, and cross-process lock path in this codebase is resolved from
 * this single value rather than from `process.cwd()` ad hoc in each file,
 * so the web app and the separate camera-service process always agree on
 * where things live - this matters most for the cross-process camera lock
 * (see fileLock.ts), which silently stops serializing hardware access
 * between the two processes if they disagree on this directory.
 *
 * Resolution order:
 * 1. `PLANTLAB_ROOT_DIR`, if set - an explicit, documented override for
 *    deployments where the working directory can't be trusted (e.g. a
 *    systemd unit or cron invocation with an unexpected WorkingDirectory).
 * 2. `process.cwd()` - correct for `next dev`/`next start` (Next.js itself
 *    already requires being launched from the project root, or with an
 *    explicit directory argument) and for `npm run`/`pnpm run` invocations
 *    of scripts/*.ts, which always run with cwd set to the package root.
 *
 * Deliberately not memoized, so tests can exercise both branches by
 * changing `process.env.PLANTLAB_ROOT_DIR` between calls.
 */
export function resolveRootDir(): string {
  const override = process.env.PLANTLAB_ROOT_DIR;
  return path.resolve(override && override.trim().length > 0 ? override.trim() : process.cwd());
}

export function resolveDataDir(): string {
  return path.join(resolveRootDir(), "data");
}

export function resolveProjectsDataDir(): string {
  return path.join(resolveDataDir(), "projects");
}

export function resolveCaptureSourcesDataDir(): string {
  return path.join(resolveDataDir(), "capture-sources");
}

/** Cross-process camera lock directory - see fileLock.ts. */
export function resolveRuntimeLocksDir(): string {
  return path.join(resolveDataDir(), "runtime", "locks");
}

export function resolveBackupDir(): string {
  const override = process.env.PLANTLAB_BACKUP_DIR;
  return path.resolve(
    override && override.trim().length > 0 ? override.trim() : path.join(resolveRootDir(), "backups"),
  );
}

export function resolvePrismaDir(): string {
  return path.join(resolveRootDir(), "prisma");
}

/**
 * Resolves a `file:...` SQLite DATABASE_URL to an absolute path, matching
 * Prisma's own resolution rule for relative SQLite paths (relative to the
 * directory containing schema.prisma, not the process's cwd).
 */
export function resolveSqliteDatabasePath(databaseUrl: string): string {
  const prefix = "file:";
  if (!databaseUrl.startsWith(prefix)) {
    throw new Error(`Only file: SQLite DATABASE_URL values are supported, got: ${databaseUrl}`);
  }

  const raw = databaseUrl.slice(prefix.length).replace(/^"|"$/g, "");
  return path.isAbsolute(raw) ? raw : path.resolve(resolvePrismaDir(), raw);
}

/**
 * Fallback for standalone scripts that run before Prisma's own automatic
 * .env loading has had a chance to populate process.env.DATABASE_URL (or
 * that don't import @prisma/client at all, e.g. a pure filesystem check).
 * Mirrors Prisma CLI's own behavior of reading DATABASE_URL from `.env` at
 * the repository root.
 */
export async function readDatabaseUrlFromEnvFile(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const envPath = path.join(resolveRootDir(), ".env");
  const contents = await readFile(envPath, "utf8").catch(() => "");
  const match = contents.match(/^DATABASE_URL=(.+)$/m);
  return match?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
}

export type ResolvedPlantLabPaths = {
  rootDir: string;
  dataDir: string;
  projectsDataDir: string;
  captureSourcesDataDir: string;
  runtimeLocksDir: string;
  backupDir: string;
};

export function resolveAllPaths(): ResolvedPlantLabPaths {
  return {
    rootDir: resolveRootDir(),
    dataDir: resolveDataDir(),
    projectsDataDir: resolveProjectsDataDir(),
    captureSourcesDataDir: resolveCaptureSourcesDataDir(),
    runtimeLocksDir: resolveRuntimeLocksDir(),
    backupDir: resolveBackupDir(),
  };
}

/** Logs resolved paths at startup - never logs environment variable values, only the paths derived from them. */
export function logResolvedPaths(logger: Pick<Console, "log"> = console): void {
  const resolved = resolveAllPaths();
  logger.log(
    JSON.stringify({
      level: "info",
      message: "Resolved PlantLab paths",
      ...resolved,
      time: new Date().toISOString(),
    }),
  );
}
