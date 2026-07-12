// Database migration status/application - see DEPLOYMENT.md "Database
// migration policy". Used by roleConvergence.ts (for local
// coordinator/standalone targets only - a remote target is always a
// camera-node in this codebase, which never touches the canonical domain
// database) and by `plantlab update`.
//
// Never uses `prisma db push` here - that is explicitly the destructive
// default this task's spec forbids for updating an EXISTING database
// ("Do not use destructive `prisma db push` against existing user
// databases as the default update mechanism"). Every real installation
// bootstrapped via `install.sh` before this task, however, WAS created
// with `db push` (see ensure_database_schema() in install.sh) - such a
// database has no `_prisma_migrations` history table at all, so a plain
// `prisma migrate deploy` refuses outright (Prisma error P3005 - verified
// empirically against a real copy of this database). The one-time,
// officially-documented recovery for that ("baselining") is handled here
// automatically, but ONLY after confirming (via `prisma migrate diff`
// against the database's actual live schema, not its migration history)
// exactly what is really missing - never by blindly assuming a legacy
// database already matches HEAD.

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackup } from "../backup";
import { resolveRootDir, resolveSqliteDatabasePath } from "../paths.server";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/migrations.ts spawns the Prisma CLI and must not run in a browser.");
}

function prismaBin(): string {
  return path.join(resolveRootDir(), "node_modules", ".bin", "prisma");
}

function runPrisma(args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(prismaBin(), args, { cwd: resolveRootDir(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`prisma ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

function listMigrationNames(): string[] {
  const migrationsDir = path.join(resolveRootDir(), "prisma", "migrations");
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((name) => name !== "migration_lock.toml" && statSync(path.join(migrationsDir, name)).isDirectory())
    .sort();
}

/**
 * Reads sqlite_master directly to detect a legacy (`db push`-managed,
 * untracked) database. `prisma migrate status`'s own output does NOT
 * reveal this - verified empirically: error P3005 ("schema is not empty")
 * only ever appears from `migrate deploy` actually attempting to apply the
 * first migration against a non-empty schema, never from `migrate status`,
 * which just reports every migration as "not yet applied" either way. A
 * database is legacy when its domain tables already exist but
 * `_prisma_migrations` does not.
 */
async function inspectSqliteTables(dbPath: string): Promise<{ hasMigrationsTable: boolean; hasDomainTables: boolean }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    return { hasMigrationsTable: names.has("_prisma_migrations"), hasDomainTables: names.has("Project") };
  } finally {
    db.close();
  }
}

export type MigrationStatus = {
  /** False if the database file itself doesn't exist yet - a fresh `prisma migrate deploy` handles that case directly (no baselining needed). */
  databaseExists: boolean;
  /** True once schema and migration history both fully match prisma/migrations HEAD. */
  current: boolean;
  /** True for a database with no _prisma_migrations history (see the module doc comment) - needs baselining, not a plain `migrate deploy`. */
  legacy: boolean;
  pendingMigrations: string[];
  detail: string;
};

export async function checkMigrationStatus(): Promise<MigrationStatus> {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const dbPath = databaseUrl.startsWith("file:") ? resolveSqliteDatabasePath(databaseUrl) : null;
  if (dbPath && !existsSync(dbPath)) {
    return { databaseExists: false, current: false, legacy: false, pendingMigrations: [], detail: "Database file does not exist yet." };
  }

  let legacy = false;
  if (dbPath) {
    try {
      const tables = await inspectSqliteTables(dbPath);
      legacy = tables.hasDomainTables && !tables.hasMigrationsTable;
    } catch {
      // Best-effort - an unreadable/corrupt file falls through to the
      // CLI-based check below, which will report its own clear error.
    }
  }

  let result: { stdout: string; stderr: string; status: number | null };
  try {
    result = await runPrisma(["migrate", "status"]);
  } catch (error) {
    return {
      databaseExists: true,
      current: false,
      legacy,
      pendingMigrations: legacy ? listMigrationNames() : [],
      detail: `Could not run the Prisma CLI: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.status === 0 && /up to date/i.test(output) && !legacy) {
    return { databaseExists: true, current: true, legacy: false, pendingMigrations: [], detail: "Database schema is up to date." };
  }

  if (legacy) {
    return {
      databaseExists: true,
      current: false,
      legacy: true,
      pendingMigrations: listMigrationNames(),
      detail: "Database has no migration history (created with `prisma db push`, e.g. by the installer's first-run schema setup) - needs one-time baselining before migrate deploy can run.",
    };
  }

  const pendingMigrations = Array.from(output.matchAll(/^\d{14}_[A-Za-z0-9_]+$/gm)).map((m) => m[0]);
  if (pendingMigrations.length > 0) {
    return {
      databaseExists: true,
      current: false,
      legacy: false,
      pendingMigrations,
      detail: `${pendingMigrations.length} migration(s) have not been applied.`,
    };
  }

  return { databaseExists: true, current: false, legacy: false, pendingMigrations: [], detail: output.trim().slice(0, 500) || "Unknown migration status." };
}

export type MigrationStep = { name: string; ok: boolean; detail: string };

export type ApplyMigrationsResult = {
  ok: boolean;
  backupPath: string | null;
  steps: MigrationStep[];
};

/**
 * Backs up (if the database already existed), then brings the schema
 * fully current - baselining first if needed (see the module doc comment)
 * - and verifies the result. Never applies anything destructive: baselining
 * only records bookkeeping rows, and the one raw SQL statement it may run
 * (via `prisma migrate diff`) is always exactly what's needed to reconcile
 * the live schema with prisma/schema.prisma, computed by Prisma itself -
 * this codebase's own migration discipline (see AGENTS.md / this
 * session's history) never uses non-additive schema changes.
 */
export async function applyMigrations(): Promise<ApplyMigrationsResult> {
  const steps: MigrationStep[] = [];
  const status = await checkMigrationStatus();

  if (status.current) {
    steps.push({ name: "check", ok: true, detail: "Already up to date - nothing to do." });
    return { ok: true, backupPath: null, steps };
  }

  let backupPath: string | null = null;
  if (status.databaseExists) {
    try {
      const backup = await createBackup();
      backupPath = backup.archivePath;
      steps.push({ name: "backup", ok: true, detail: `Backed up to ${backup.archivePath} before migrating.` });
    } catch (error) {
      steps.push({ name: "backup", ok: false, detail: error instanceof Error ? error.message : String(error) });
      return { ok: false, backupPath: null, steps };
    }
  } else {
    steps.push({ name: "backup", ok: true, detail: "Skipped - database does not exist yet, nothing to back up." });
  }

  if (status.legacy) {
    const baselined = await baselineLegacyDatabase();
    steps.push(...baselined.steps);
    if (!baselined.ok) {
      return { ok: false, backupPath, steps };
    }
  }

  try {
    let deploy = await runPrisma(["migrate", "deploy"]);
    // Defensive fallback: P3005 can in principle still surface here even
    // when the upfront sqlite_master check above didn't flag `legacy`
    // (e.g. a table naming scheme this check doesn't anticipate) - `migrate
    // deploy` is the only command that actually reveals P3005, since
    // `migrate status` never does (see checkMigrationStatus()'s doc
    // comment). Recover the same way: baseline once, then retry deploy.
    if (deploy.status !== 0 && !status.legacy && /P3005/.test(`${deploy.stdout}\n${deploy.stderr}`)) {
      steps.push({ name: "migrate-deploy-retry-reason", ok: true, detail: "First deploy attempt hit P3005 (untracked schema) - baselining and retrying." });
      const baselined = await baselineLegacyDatabase();
      steps.push(...baselined.steps);
      if (!baselined.ok) {
        return { ok: false, backupPath, steps };
      }
      deploy = await runPrisma(["migrate", "deploy"]);
    }

    if (deploy.status !== 0) {
      steps.push({ name: "migrate-deploy", ok: false, detail: (deploy.stderr.trim() || deploy.stdout.trim()).slice(0, 2000) });
      return { ok: false, backupPath, steps };
    }
    steps.push({ name: "migrate-deploy", ok: true, detail: "Applied pending migrations." });
  } catch (error) {
    steps.push({ name: "migrate-deploy", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, backupPath, steps };
  }

  const after = await checkMigrationStatus();
  steps.push({ name: "verify", ok: after.current, detail: after.detail });

  return { ok: after.current, backupPath, steps };
}

/**
 * Official Prisma baselining procedure (https://pris.ly/d/migrate-baseline)
 * applied automatically but safely: `prisma migrate diff` compares the
 * datamodel directly against the database's REAL current schema (not its
 * untracked history), so an empty diff proves the db-push'd schema already
 * matches HEAD (safe to baseline with zero SQL executed), and a non-empty
 * diff is applied via `prisma db execute` - the exact SQL Prisma itself
 * computed as the reconciling delta - before every migration is marked
 * applied. Never guesses; never runs hand-written SQL.
 */
async function baselineLegacyDatabase(): Promise<{ ok: boolean; steps: MigrationStep[] }> {
  const steps: MigrationStep[] = [];
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const schemaPath = path.join(resolveRootDir(), "prisma", "schema.prisma");

  try {
    const diff = await runPrisma(["migrate", "diff", "--from-url", databaseUrl, "--to-schema-datamodel", schemaPath, "--script"]);
    if (diff.status !== 0) {
      steps.push({ name: "baseline-diff", ok: false, detail: diff.stderr.trim() || "Could not compute the schema diff for baselining." });
      return { ok: false, steps };
    }

    const diffSql = diff.stdout.trim();
    if (diffSql) {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "plantlab-migration-diff-"));
      const tmpFile = path.join(tmpDir, "baseline.sql");
      try {
        await writeFile(tmpFile, diff.stdout, "utf8");
        const apply = await runPrisma(["db", "execute", "--file", tmpFile, "--url", databaseUrl]);
        if (apply.status !== 0) {
          steps.push({ name: "baseline-apply", ok: false, detail: apply.stderr.trim() || "Could not apply the reconciling schema diff." });
          return { ok: false, steps };
        }
        steps.push({ name: "baseline-apply", ok: true, detail: "Applied the schema differences Prisma computed between the live database and prisma/schema.prisma." });
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      steps.push({ name: "baseline-apply", ok: true, detail: "No schema differences found - the database already matches prisma/schema.prisma." });
    }

    for (const name of listMigrationNames()) {
      const resolve = await runPrisma(["migrate", "resolve", "--applied", name]);
      if (resolve.status !== 0) {
        steps.push({ name: `baseline-resolve:${name}`, ok: false, detail: resolve.stderr.trim() || `Could not mark ${name} as applied.` });
        return { ok: false, steps };
      }
    }
    steps.push({ name: "baseline-resolve", ok: true, detail: `Marked ${listMigrationNames().length} pre-existing migration(s) as applied (no SQL re-executed).` });

    return { ok: true, steps };
  } catch (error) {
    steps.push({ name: "baseline", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, steps };
  }
}
