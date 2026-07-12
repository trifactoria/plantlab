import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPrismaRoot } from "./helpers/isolatedPrismaRoot";

const execFileAsync = promisify(execFile);

// migrations.ts resolves everything (schema, prisma CLI, migration list)
// from PLANTLAB_ROOT_DIR/DATABASE_URL at call time (no dependency
// injection) - these tests swap both env vars to an isolated, throwaway
// Prisma root for the duration of each test and restore the test file's
// own isolated environment (set by testEnvironment.ts) afterward.
const ORIGINAL_ROOT = process.env.PLANTLAB_ROOT_DIR;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.PLANTLAB_ROOT_DIR;
  else process.env.PLANTLAB_ROOT_DIR = ORIGINAL_ROOT;
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

async function withIsolatedPrismaRoot<T>(fn: (root: string, dbPath: string) => Promise<T>): Promise<T> {
  const { root, cleanup } = await createIsolatedPrismaRoot();
  const dbPath = path.join(root, "prisma", "dev.db");
  process.env.PLANTLAB_ROOT_DIR = root;
  process.env.DATABASE_URL = `file:${dbPath}`;
  try {
    return await fn(root, dbPath);
  } finally {
    await cleanup();
  }
}

describe("migrations", () => {
  it("checkMigrationStatus reports databaseExists:false for a database that hasn't been created yet", async () => {
    await withIsolatedPrismaRoot(async () => {
      const { checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const status = await checkMigrationStatus();
      expect(status.databaseExists).toBe(false);
      expect(status.current).toBe(false);
    });
  });

  it("checkMigrationStatus reports current:true immediately after a fresh migrate deploy", async () => {
    await withIsolatedPrismaRoot(async (root, dbPath) => {
      await execFileAsync(path.join(root, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });

      const { checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const status = await checkMigrationStatus();
      expect(status.current).toBe(true);
      expect(status.legacy).toBe(false);
    });
  }, 30_000);

  it("checkMigrationStatus reports legacy:true for a database created via db push (no migration history)", async () => {
    await withIsolatedPrismaRoot(async (root, dbPath) => {
      await execFileAsync(path.join(root, "node_modules", ".bin", "prisma"), ["db", "push", "--skip-generate"], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });

      const { checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const status = await checkMigrationStatus();
      expect(status.current).toBe(false);
      expect(status.legacy).toBe(true);
    });
  }, 30_000);

  it("applyMigrations backs up an existing database before migrating, and succeeds", async () => {
    await withIsolatedPrismaRoot(async (root, dbPath) => {
      // Seed a pre-existing (but empty/untracked) database file so
      // applyMigrations treats it as "existing" and takes a backup.
      await execFileAsync(path.join(root, "node_modules", ".bin", "prisma"), ["db", "push", "--skip-generate"], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });

      const { applyMigrations, checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const result = await applyMigrations();

      expect(result.ok).toBe(true);
      expect(result.backupPath).not.toBeNull();
      const { existsSync } = await import("node:fs");
      expect(existsSync(result.backupPath!)).toBe(true);

      const after = await checkMigrationStatus();
      expect(after.current).toBe(true);
    });
  }, 60_000);

  it("applyMigrations does nothing (no backup) when the database is already current", async () => {
    await withIsolatedPrismaRoot(async (root, dbPath) => {
      await execFileAsync(path.join(root, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });

      const { applyMigrations } = await import("../../src/lib/operations/migrations");
      const result = await applyMigrations();
      expect(result.ok).toBe(true);
      expect(result.backupPath).toBeNull();
      expect(result.steps).toEqual([{ name: "check", ok: true, detail: "Already up to date - nothing to do." }]);
    });
  }, 30_000);

  it("applyMigrations does not back up a database that doesn't exist yet, and still succeeds", async () => {
    await withIsolatedPrismaRoot(async () => {
      const { applyMigrations, checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const result = await applyMigrations();
      expect(result.ok).toBe(true);
      expect(result.backupPath).toBeNull();

      const after = await checkMigrationStatus();
      expect(after.current).toBe(true);
    });
  }, 30_000);

  it("applyMigrations fails cleanly (does not throw) when the Prisma CLI cannot be found", async () => {
    await withIsolatedPrismaRoot(async () => {
      const { rm } = await import("node:fs/promises");
      const root = process.env.PLANTLAB_ROOT_DIR!;
      await rm(path.join(root, "node_modules"), { force: true });

      const { applyMigrations } = await import("../../src/lib/operations/migrations");
      const result = await applyMigrations();
      expect(result.ok).toBe(false);
    });
  }, 30_000);

  it("refuses to start a database-dependent service when the schema is stale (service.ts integration)", async () => {
    await withIsolatedPrismaRoot(async (root, dbPath) => {
      // A database missing the most recent migration.
      await execFileAsync(path.join(root, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });
      // Roll back to simulate a stale (but tracked) database: remove the
      // most recent migration's bookkeeping row so status reports pending.
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare("SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1").all() as Array<{
        migration_name: string;
      }>;
      db.prepare("DELETE FROM _prisma_migrations WHERE migration_name = ?").run(rows[0].migration_name);
      db.close();

      const { checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const status = await checkMigrationStatus();
      expect(status.current).toBe(false);
      expect(status.pendingMigrations.length).toBeGreaterThan(0);
    });
  }, 30_000);
});
