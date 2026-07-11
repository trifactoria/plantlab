import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createBackup, listBackups } from "../../src/lib/backup";

const execFileAsync = promisify(execFile);

describe("backup", () => {
  it("creates an archive with database, data directory, and manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-backup-test-"));
    const dbPath = path.join(root, "dev.db");
    const dataRoot = path.join(root, "data", "projects");
    const backupDir = path.join(root, "backups");
    await writeFile(dbPath, "sqlite bytes");
    await writeFile(path.join(dataRoot, "project-1", "photos", "photo.txt"), "photo", { flag: "w" }).catch(async () => {
      await import("node:fs/promises").then((fs) => fs.mkdir(path.join(dataRoot, "project-1", "photos"), { recursive: true }));
      await writeFile(path.join(dataRoot, "project-1", "photos", "photo.txt"), "photo");
    });

    const backup = await createBackup({
      databaseUrl: `file:${dbPath}`,
      dataRoot,
      backupDir,
      now: new Date("2026-07-11T12:00:00Z"),
      version: "test-version",
    });

    expect(backup.archivePath).toContain("plantlab-backup-2026-07-11T12-00-00-000Z.tar.gz");
    expect(backup.sizeBytes).toBeGreaterThan(0);
    const { stdout } = await execFileAsync("tar", ["-tzf", backup.archivePath]);
    expect(stdout).toContain("database.sqlite");
    expect(stdout).toContain("manifest.json");
    expect(stdout).toContain("projects/project-1/photos/photo.txt");

    const listed = await listBackups(backupDir);
    expect(listed).toEqual([backup.archivePath]);
    expect(backup.manifest.plantlabVersion).toBe("test-version");
    expect(backup.manifest.databasePath).toBe(dbPath);
  });
});
