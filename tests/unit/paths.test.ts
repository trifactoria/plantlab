import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDatabaseUrlFromEnvFile,
  resolveAllPaths,
  resolveBackupDir,
  resolveCaptureSourcesDataDir,
  resolveDataDir,
  resolvePrismaDir,
  resolveProjectsDataDir,
  resolveRootDir,
  resolveRuntimeLocksDir,
  resolveSqliteDatabasePath,
} from "../../src/lib/paths";

const ORIGINAL_ROOT = process.env.PLANTLAB_ROOT_DIR;
const ORIGINAL_BACKUP_DIR = process.env.PLANTLAB_BACKUP_DIR;

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) {
    delete process.env.PLANTLAB_ROOT_DIR;
  } else {
    process.env.PLANTLAB_ROOT_DIR = ORIGINAL_ROOT;
  }
  if (ORIGINAL_BACKUP_DIR === undefined) {
    delete process.env.PLANTLAB_BACKUP_DIR;
  } else {
    process.env.PLANTLAB_BACKUP_DIR = ORIGINAL_BACKUP_DIR;
  }
});

describe("resolveRootDir", () => {
  it("falls back to process.cwd() when PLANTLAB_ROOT_DIR is unset", () => {
    delete process.env.PLANTLAB_ROOT_DIR;
    expect(resolveRootDir()).toBe(path.resolve(process.cwd()));
  });

  it("prefers an explicit PLANTLAB_ROOT_DIR override, so both processes agree even with different cwd", () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-root-override";
    expect(resolveRootDir()).toBe(path.resolve("/tmp/plantlab-root-override"));
  });

  it("ignores a blank PLANTLAB_ROOT_DIR and falls back to cwd", () => {
    process.env.PLANTLAB_ROOT_DIR = "   ";
    expect(resolveRootDir()).toBe(path.resolve(process.cwd()));
  });

  it("is not memoized - later calls see a changed override immediately", () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-root-a";
    expect(resolveRootDir()).toBe(path.resolve("/tmp/plantlab-root-a"));
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-root-b";
    expect(resolveRootDir()).toBe(path.resolve("/tmp/plantlab-root-b"));
  });
});

describe("derived directories", () => {
  it("resolves every data/backup/prisma directory under the same root", () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-derived-root";
    delete process.env.PLANTLAB_BACKUP_DIR;

    expect(resolveDataDir()).toBe("/tmp/plantlab-derived-root/data");
    expect(resolveProjectsDataDir()).toBe("/tmp/plantlab-derived-root/data/projects");
    expect(resolveCaptureSourcesDataDir()).toBe("/tmp/plantlab-derived-root/data/capture-sources");
    expect(resolveRuntimeLocksDir()).toBe("/tmp/plantlab-derived-root/data/runtime/locks");
    expect(resolveBackupDir()).toBe("/tmp/plantlab-derived-root/backups");
    expect(resolvePrismaDir()).toBe("/tmp/plantlab-derived-root/prisma");
  });

  it("PLANTLAB_BACKUP_DIR overrides the default backup directory independent of the root", () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-derived-root";
    process.env.PLANTLAB_BACKUP_DIR = "/mnt/external/plantlab-backups";
    expect(resolveBackupDir()).toBe("/mnt/external/plantlab-backups");
  });

  it("resolveAllPaths returns every value consistently in one call", () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-all";
    delete process.env.PLANTLAB_BACKUP_DIR;
    const all = resolveAllPaths();
    expect(all.rootDir).toBe("/tmp/plantlab-all");
    expect(all.dataDir).toBe("/tmp/plantlab-all/data");
    expect(all.projectsDataDir).toBe("/tmp/plantlab-all/data/projects");
    expect(all.captureSourcesDataDir).toBe("/tmp/plantlab-all/data/capture-sources");
    expect(all.runtimeLocksDir).toBe("/tmp/plantlab-all/data/runtime/locks");
    expect(all.backupDir).toBe("/tmp/plantlab-all/backups");
  });
});

describe("resolveSqliteDatabasePath", () => {
  it("resolves a relative file: URL against the prisma directory, matching Prisma's own rule", () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-db-root";
    expect(resolveSqliteDatabasePath("file:./dev.db")).toBe("/tmp/plantlab-db-root/prisma/dev.db");
  });

  it("leaves an absolute file: URL untouched", () => {
    expect(resolveSqliteDatabasePath("file:/var/lib/plantlab/prod.db")).toBe("/var/lib/plantlab/prod.db");
  });

  it("rejects a non-file: DATABASE_URL", () => {
    expect(() => resolveSqliteDatabasePath("postgres://localhost/plantlab")).toThrow(/Only file:/);
  });
});

describe("readDatabaseUrlFromEnvFile", () => {
  it("returns an empty string when no .env file exists at the resolved root", async () => {
    process.env.PLANTLAB_ROOT_DIR = "/tmp/plantlab-nonexistent-root-for-env-test";
    await expect(readDatabaseUrlFromEnvFile()).resolves.toBe("");
  });
});
