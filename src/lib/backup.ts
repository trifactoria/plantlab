import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readDatabaseUrlFromEnvFile, resolveBackupDir, resolveProjectsDataDir, resolveSqliteDatabasePath } from "./paths.server";

const execFileAsync = promisify(execFile);

export type BackupOptions = {
  databaseUrl?: string;
  dataRoot?: string;
  backupDir?: string;
  now?: Date;
  version?: string | null;
};

function timestampForPath(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function createBackup(options: BackupOptions = {}) {
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

  const manifest = {
    plantlabVersion: options.version ?? process.env.npm_package_version ?? null,
    archiveTime: now.toISOString(),
    databasePath,
    includedProjectDirectories: [dataRoot],
  };
  await writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archivePath = path.join(backupDir, `${baseName}.tar.gz`);
  await execFileAsync("tar", ["-czf", archivePath, "-C", stagingDir, "database.sqlite", "manifest.json", "-C", path.dirname(dataRoot), path.basename(dataRoot)]);
  const archiveStat = await stat(archivePath);
  await rm(stagingDir, { recursive: true, force: true });

  return { archivePath, sizeBytes: archiveStat.size, manifest };
}

export async function listBackups(backupDir = resolveBackupDir()) {
  const resolved = path.resolve(backupDir);
  const entries = await readdir(resolved).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".tar.gz"))
    .sort()
    .map((entry) => path.join(resolved, entry));
}
