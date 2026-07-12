import path from "node:path";

/**
 * Guards against this module ever running in a real browser (a Client
 * Component that got bundled with it), without breaking its other
 * legitimate consumers: Vitest unit tests and scripts/*.ts run directly
 * via tsx, neither of which define `window`. The `server-only` npm
 * package was deliberately not used here - its poison-pill only becomes a
 * no-op under Next.js's "react-server" bundler condition, which plain
 * Vitest and tsx do not set, so it throws for every legitimate consumer of
 * this file (confirmed: it broke the entire unit test suite and would
 * equally break `pnpm doctor`/`pnpm camera:service`). The `.server.ts`
 * filename plus this runtime guard is this codebase's server-only
 * boundary instead.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/paths.server.ts touches the filesystem and process environment - it must never be imported from a Client Component or run in a browser.",
  );
}

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
 *
 * Under Vitest (`process.env.VITEST` is set automatically by the test
 * runner) a missing `PLANTLAB_ROOT_DIR` is treated as a hard failure
 * instead of silently falling back to `process.cwd()` - which, under
 * `vitest run`, IS the real repository root. Automated tests must never
 * read or write the real development database or `data/projects/`; see
 * tests/unit/setup/testEnvironment.ts (registered as a Vitest setupFile),
 * which sets this before any test file's own imports run. If this throws,
 * that setup file isn't wired up correctly for the code path that hit it.
 */
export function resolveRootDir(): string {
  const override = process.env.PLANTLAB_ROOT_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }

  if (process.env.VITEST) {
    throw new Error(
      "PLANTLAB_ROOT_DIR is not set while running under Vitest - refusing to fall back to " +
        "process.cwd() (the real repository root). Tests must not touch real PlantLab data. " +
        "See tests/unit/setup/testEnvironment.ts.",
    );
  }

  return path.resolve(process.cwd());
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

/**
 * Staging directory for remote HTTP ingest uploads (see src/lib/ingest.server.ts)
 * - incoming files are streamed here as `.partial` before being verified
 * and atomically renamed into their canonical storage location under
 * resolveProjectsDataDir()/resolveCaptureSourcesDataDir(). Never treated as
 * canonical storage itself.
 */
export function resolveIngestDir(): string {
  const override = process.env.PLANTLAB_INGEST_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(resolveDataDir(), "ingest");
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
  ingestDir: string;
  runtimeLocksDir: string;
  backupDir: string;
};

export function resolveAllPaths(): ResolvedPlantLabPaths {
  return {
    rootDir: resolveRootDir(),
    dataDir: resolveDataDir(),
    projectsDataDir: resolveProjectsDataDir(),
    captureSourcesDataDir: resolveCaptureSourcesDataDir(),
    ingestDir: resolveIngestDir(),
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
