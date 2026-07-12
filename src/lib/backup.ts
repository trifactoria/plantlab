import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readDatabaseUrlFromEnvFile, resolveBackupDir, resolveProjectsDataDir, resolveRootDir, resolveSqliteDatabasePath } from "./paths.server";
import { prisma } from "./prisma";
import { effectiveProjectLifecycleState } from "./projectLifecycle";

const execFileAsync = promisify(execFile);

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/backup.ts touches the filesystem - it must never be imported from a Client Component or run in a browser.",
  );
}

/**
 * Backup manifest format. v1 (no `format`/`checksums` fields) is what every
 * backup created before this task has - readers must treat those fields as
 * optional, never assume their presence. Adding fields here must always be
 * additive: a v1 manifest is still a valid (partial) v2 manifest, and an
 * old backup's restorability never depends on any field introduced after
 * v1. See ARCHITECTURE.md "Backup architecture".
 */
export type BackupManifest = {
  format?: "plantlab-backup/2";
  plantlabVersion: string | null;
  archiveTime: string;
  databasePath: string;
  includedProjectDirectories: string[];
  /** sha256 of the database file copy at backup time (present from v2 onward). */
  databaseSha256?: string;
  /** sha256 of the final .tar.gz archive itself (present from v2 onward - lets verifyBackup() detect archive corruption without re-deriving anything from its contents). */
  archiveSha256?: string;
  /**
   * Best-effort snapshot of every project's lifecycle state at backup time
   * (see src/lib/projectLifecycle.ts) - purely informational metadata for
   * future backup/publication tooling, never consulted by restore.
   */
  projectLifecycleSnapshot?: Array<{ id: string; name: string; lifecycleState: string }>;
};

export type BackupOptions = {
  /** Overrides the file-level source only (the sqlite file that gets copied into the archive). The project-lifecycle snapshot always reflects the actual connected Prisma database (process.env.DATABASE_URL) - in real production use there is only ever one, so this only matters for tests that pass a different databaseUrl purely to isolate the file-copy mechanics. */
  databaseUrl?: string;
  dataRoot?: string;
  backupDir?: string;
  now?: Date;
  version?: string | null;
};

function timestampForPath(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function snapshotProjectLifecycle(): Promise<BackupManifest["projectLifecycleSnapshot"]> {
  try {
    const projects = await prisma.project.findMany({ select: { id: true, name: true, lifecycleState: true } });
    return projects.map((p) => ({ id: p.id, name: p.name, lifecycleState: effectiveProjectLifecycleState(p.lifecycleState) }));
  } catch {
    // Best-effort only - a backup must still succeed even if, for example,
    // the database connection used for this snapshot query is unavailable
    // for some transient reason unrelated to the file-level backup itself.
    return undefined;
  }
}

/**
 * Where a finished backup archive (plus its sidecar manifest) gets stored.
 * Exactly one implementation exists today (local filesystem, under
 * resolveBackupDir()) - this interface exists so a future external-SSD,
 * remote-coordinator, NAS, or cloud destination can be added later without
 * changing createBackup()'s own logic. No remote destination is implemented
 * in this task - see ARCHITECTURE.md.
 */
export type BackupDestination = {
  readonly name: string;
  /** Returns the final resting path/identifier of the stored archive. */
  store(archivePath: string, manifestPath: string): Promise<{ location: string }>;
};

export class LocalFilesystemDestination implements BackupDestination {
  readonly name = "local-filesystem";
  private readonly directory: string;

  constructor(directory: string = resolveBackupDir()) {
    this.directory = directory;
  }

  async store(archivePath: string, _manifestPath: string): Promise<{ location: string }> {
    // The archive (and its sidecar manifest) are already written directly
    // into this destination's directory by createBackup() below - a local
    // destination has no separate "upload" step. This method exists so the
    // BackupDestination interface is exercised by the one real
    // implementation today, and so a future remote destination has an
    // obvious place to implement an actual transfer.
    return { location: archivePath };
  }
}

export type CreateBackupResult = {
  archivePath: string;
  manifestPath: string;
  sizeBytes: number;
  manifest: BackupManifest;
  destination: { name: string; location: string };
};

export async function createBackup(options: BackupOptions = {}): Promise<CreateBackupResult> {
  const now = options.now ?? new Date();
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? (await readDatabaseUrlFromEnvFile());
  const databasePath = resolveSqliteDatabasePath(databaseUrl);
  const dataRoot = path.resolve(options.dataRoot ?? resolveProjectsDataDir());
  const backupDir = path.resolve(options.backupDir ?? resolveBackupDir());

  const dbStat = await stat(databasePath).catch(() => null);
  if (!dbStat?.isFile()) {
    throw new Error(`Database file is not readable: ${databasePath}`);
  }

  const dataStat = await stat(dataRoot).catch(() => null);
  if (!dataStat?.isDirectory()) {
    throw new Error(`Project data directory is not readable: ${dataRoot}`);
  }

  await mkdir(backupDir, { recursive: true });
  const baseName = `plantlab-backup-${timestampForPath(now)}`;
  const stagingDir = path.join(backupDir, `${baseName}.staging`);
  await mkdir(stagingDir, { recursive: true });

  const stagedDbPath = path.join(stagingDir, "database.sqlite");
  await copyFile(databasePath, stagedDbPath);
  const databaseSha256 = await sha256File(stagedDbPath);

  const manifest: BackupManifest = {
    format: "plantlab-backup/2",
    plantlabVersion: options.version ?? process.env.npm_package_version ?? null,
    archiveTime: now.toISOString(),
    databasePath,
    includedProjectDirectories: [dataRoot],
    databaseSha256,
    projectLifecycleSnapshot: await snapshotProjectLifecycle(),
  };
  // Written into the tar itself (unchanged from v1) so a restore is
  // self-contained even without the sidecar file below.
  await writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archivePath = path.join(backupDir, `${baseName}.tar.gz`);
  await execFileAsync("tar", ["-czf", archivePath, "-C", stagingDir, "database.sqlite", "manifest.json", "-C", path.dirname(dataRoot), path.basename(dataRoot)]);
  const archiveStat = await stat(archivePath);
  manifest.archiveSha256 = await sha256File(archivePath);
  await rm(stagingDir, { recursive: true, force: true });

  // Sidecar manifest next to the archive - lets list()/verify() inspect
  // metadata (including the archive's own checksum) without extracting the
  // whole tar. Purely additive: a backup created before this task simply
  // has no sidecar, and every consumer here treats that as "legacy, no
  // extended metadata" rather than an error.
  const manifestPath = `${archivePath}.manifest.json`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const destination = new LocalFilesystemDestination(backupDir);
  const stored = await destination.store(archivePath, manifestPath);

  return {
    archivePath,
    manifestPath,
    sizeBytes: archiveStat.size,
    manifest,
    destination: { name: destination.name, location: stored.location },
  };
}

export async function listBackups(backupDir = resolveBackupDir()) {
  const resolved = path.resolve(backupDir);
  const entries = await readdir(resolved).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".tar.gz"))
    .sort()
    .map((entry) => path.join(resolved, entry));
}

export type BackupListEntry = {
  archivePath: string;
  sizeBytes: number;
  mtime: Date;
  /** Loaded from the sidecar `.manifest.json` when present; null for a backup created before this task (or one whose sidecar was deleted). */
  manifest: BackupManifest | null;
};

/** Like listBackups(), but also loads each archive's sidecar manifest (best-effort - a missing/corrupt sidecar just yields manifest: null, never throws). */
export async function listBackupsWithMetadata(backupDir = resolveBackupDir()): Promise<BackupListEntry[]> {
  const archives = await listBackups(backupDir);

  return Promise.all(
    archives.map(async (archivePath) => {
      const archiveStat = await stat(archivePath);
      const manifest = await readFile(`${archivePath}.manifest.json`, "utf8")
        .then((raw) => JSON.parse(raw) as BackupManifest)
        .catch(() => null);
      return { archivePath, sizeBytes: archiveStat.size, mtime: archiveStat.mtime, manifest };
    }),
  );
}

export type VerifyBackupResult = {
  archivePath: string;
  ok: boolean;
  legacy: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

/**
 * Read-only. Verifies an archive is at least structurally intact
 * (`tar -tzf` lists the expected top-level members) and, when a sidecar
 * manifest with checksums exists, that the archive's bytes still match the
 * checksum recorded at backup time. A backup created before this task (no
 * sidecar) only gets the structural check - reported as `legacy: true`,
 * not as a failure.
 */
export async function verifyBackup(archivePath: string): Promise<VerifyBackupResult> {
  const checks: VerifyBackupResult["checks"] = [];

  const archiveStat = await stat(archivePath).catch(() => null);
  if (!archiveStat?.isFile()) {
    return { archivePath, ok: false, legacy: false, checks: [{ name: "archive-exists", ok: false, detail: "Archive file not found." }] };
  }
  checks.push({ name: "archive-exists", ok: true, detail: `${archiveStat.size} bytes.` });

  let members: string[] = [];
  try {
    const { stdout } = await execFileAsync("tar", ["-tzf", archivePath]);
    members = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const hasDatabase = members.includes("database.sqlite");
    const hasManifest = members.includes("manifest.json");
    checks.push({
      name: "archive-structure",
      ok: hasDatabase && hasManifest,
      detail: hasDatabase && hasManifest
        ? `Contains database.sqlite, manifest.json, and ${members.length - 2} project data entr${members.length - 2 === 1 ? "y" : "ies"}.`
        : `Missing expected member(s): ${[!hasDatabase && "database.sqlite", !hasManifest && "manifest.json"].filter(Boolean).join(", ")}.`,
    });
  } catch (error) {
    checks.push({ name: "archive-structure", ok: false, detail: `Could not list archive contents: ${error instanceof Error ? error.message : String(error)}` });
  }

  const manifest = await readFile(`${archivePath}.manifest.json`, "utf8")
    .then((raw) => JSON.parse(raw) as BackupManifest)
    .catch(() => null);

  if (!manifest || !manifest.archiveSha256) {
    return { archivePath, ok: checks.every((c) => c.ok), legacy: true, checks };
  }

  const actualSha256 = await sha256File(archivePath);
  const checksumOk = actualSha256 === manifest.archiveSha256;
  checks.push({
    name: "archive-checksum",
    ok: checksumOk,
    detail: checksumOk ? "Archive sha256 matches the manifest recorded at backup time." : `Checksum mismatch - expected ${manifest.archiveSha256}, got ${actualSha256}. The archive may be corrupted.`,
  });

  return { archivePath, ok: checks.every((c) => c.ok), legacy: false, checks };
}

export type RestoreBackupResult = {
  archivePath: string;
  extractedTo: string;
  verified: VerifyBackupResult;
  nextSteps: string[];
};

/**
 * Extract-only, always into a caller-specified staging directory - NEVER
 * the live PLANTLAB_ROOT_DIR. This deliberately does not overwrite the
 * running database/data directories automatically: per this task's safety
 * requirements ("no destructive migration, no automatic cleanup of user
 * data"), swapping in a restored database/data tree live is exactly the
 * kind of destructive operation that must stay a manual, deliberate step -
 * see the printed nextSteps and DEPLOYMENT.md "Restoring a backup".
 */
export async function restoreBackup(
  archivePath: string,
  destinationDir: string,
  options: { force?: boolean } = {},
): Promise<RestoreBackupResult> {
  const resolvedDestination = path.resolve(destinationDir);
  const liveRoot = resolveRootDir();
  if (resolvedDestination === liveRoot || resolvedDestination === path.resolve(liveRoot, "data")) {
    throw new Error(
      `Refusing to extract directly into the live PlantLab root (${liveRoot}). Choose a separate staging directory, inspect the extracted contents, then manually copy what you need - see DEPLOYMENT.md "Restoring a backup".`,
    );
  }

  const verified = await verifyBackup(archivePath);
  if (!verified.ok && !options.force) {
    throw new Error(
      `Backup verification failed for ${archivePath} - refusing to extract. Failing checks: ${verified.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name} (${c.detail})`)
        .join("; ")}. Pass force to extract anyway.`,
    );
  }

  await mkdir(resolvedDestination, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", resolvedDestination]);

  return {
    archivePath,
    extractedTo: resolvedDestination,
    verified,
    nextSteps: [
      `Inspect the extracted contents at ${resolvedDestination} before doing anything else.`,
      "Stop plantlab-web.service and plantlab-camera.service (or any dev server) before replacing live data.",
      `Back up the CURRENT live database/data first (plantlab backup create) - do not skip this even though you are restoring an older backup.`,
      `Manually copy ${path.join(resolvedDestination, "database.sqlite")} over the live database, and the extracted project directory tree over the live data/projects, once you have confirmed this is what you intend.`,
      "Restart the services once the swap is complete.",
    ],
  };
}
