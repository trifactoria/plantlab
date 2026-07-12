import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createBackup, listBackups, listBackupsWithMetadata, restoreBackup, verifyBackup } from "../../src/lib/backup";

const execFileAsync = promisify(execFile);

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-backup-test-"));
  const dbPath = path.join(root, "dev.db");
  const dataRoot = path.join(root, "data", "projects");
  const backupDir = path.join(root, "backups");
  await writeFile(dbPath, "sqlite bytes");
  await mkdir(path.join(dataRoot, "project-1", "photos"), { recursive: true });
  await writeFile(path.join(dataRoot, "project-1", "photos", "photo.txt"), "photo");
  return { root, dbPath, dataRoot, backupDir };
}

describe("backup", () => {
  it("creates an archive with database, data directory, and manifest", async () => {
    const { dbPath, dataRoot, backupDir } = await makeFixture();

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

  it("writes a sidecar manifest with checksums, in the new v2 format", async () => {
    const { dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir, version: "test-version" });

    expect(backup.manifestPath).toBe(`${backup.archivePath}.manifest.json`);
    const sidecar = JSON.parse(await readFile(backup.manifestPath, "utf8"));
    expect(sidecar.format).toBe("plantlab-backup/2");
    expect(sidecar.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sidecar.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(backup.manifest.archiveSha256).toBe(sidecar.archiveSha256);
    expect(backup.destination).toEqual({ name: "local-filesystem", location: backup.archivePath });
  });

  it("listBackupsWithMetadata loads the sidecar manifest for a new backup and reports null for a legacy one", async () => {
    const { dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });

    // Simulate a pre-existing (legacy) backup with no sidecar manifest.
    const legacyArchive = path.join(backupDir, "plantlab-backup-2020-01-01T00-00-00-000Z.tar.gz");
    await execFileAsync("tar", ["-czf", legacyArchive, "-C", path.dirname(dbPath), path.basename(dbPath)]);

    const listed = await listBackupsWithMetadata(backupDir);
    const withManifest = listed.find((entry) => entry.archivePath === backup.archivePath);
    const legacy = listed.find((entry) => entry.archivePath === legacyArchive);

    expect(withManifest?.manifest?.format).toBe("plantlab-backup/2");
    expect(legacy?.manifest).toBeNull();
  });

  it("verifyBackup passes for an intact archive with a checksum manifest", async () => {
    const { dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });

    const result = await verifyBackup(backup.archivePath);
    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.checks.map((c) => c.name)).toEqual(["archive-exists", "archive-structure", "archive-checksum"]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("verifyBackup reports a legacy (no-sidecar) archive as legacy, checking structure only", async () => {
    const { dbPath, backupDir } = await makeFixture();
    await mkdir(backupDir, { recursive: true });
    const legacyArchive = path.join(backupDir, "plantlab-backup-legacy.tar.gz");
    await execFileAsync("tar", ["-czf", legacyArchive, "-C", path.dirname(dbPath), path.basename(dbPath)]);

    const result = await verifyBackup(legacyArchive);
    expect(result.legacy).toBe(true);
    expect(result.checks.map((c) => c.name)).not.toContain("archive-checksum");
  });

  it("verifyBackup fails when the archive has been corrupted after backup", async () => {
    const { dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });

    await appendFile(backup.archivePath, "corrupted-extra-bytes");

    const result = await verifyBackup(backup.archivePath);
    expect(result.ok).toBe(false);
    const checksumCheck = result.checks.find((c) => c.name === "archive-checksum");
    expect(checksumCheck?.ok).toBe(false);
  });

  it("verifyBackup reports a missing archive as a failed archive-exists check", async () => {
    const result = await verifyBackup("/nonexistent/path/does-not-exist.tar.gz");
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([{ name: "archive-exists", ok: false, detail: "Archive file not found." }]);
  });

  it("restoreBackup extracts into the given staging directory and returns actionable next steps", async () => {
    const { root, dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });

    const destinationDir = path.join(root, "restore-target");
    const result = await restoreBackup(backup.archivePath, destinationDir);

    expect(result.extractedTo).toBe(destinationDir);
    expect(result.verified.ok).toBe(true);
    expect(result.nextSteps.length).toBeGreaterThan(0);

    const entries = await readdir(destinationDir);
    expect(entries).toContain("database.sqlite");
    expect(entries).toContain("manifest.json");
    const restoredPhoto = await readFile(path.join(destinationDir, "projects", "project-1", "photos", "photo.txt"), "utf8");
    expect(restoredPhoto).toBe("photo");
  });

  it("restoreBackup refuses to extract failed verification without force", async () => {
    const { root, dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });
    await appendFile(backup.archivePath, "corrupted");

    await expect(restoreBackup(backup.archivePath, path.join(root, "restore-target"))).rejects.toThrow(/verification failed/i);
  });

  it("restoreBackup extracts a failed-verification archive when force is passed (checksum mismatch, archive itself still readable)", async () => {
    const { root, dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });
    // Tamper with the recorded checksum (not the archive bytes) - a
    // realistic case for --force: the archive is perfectly extractable,
    // but its manifest checksum no longer matches (e.g. an inconsistent
    // sidecar file), so verification fails without the archive itself
    // being unreadable.
    const tamperedManifest = JSON.parse(await readFile(backup.manifestPath, "utf8"));
    tamperedManifest.archiveSha256 = "0".repeat(64);
    await writeFile(backup.manifestPath, JSON.stringify(tamperedManifest));

    const destinationDir = path.join(root, "restore-target-forced");
    const result = await restoreBackup(backup.archivePath, destinationDir, { force: true });
    expect(result.verified.ok).toBe(false);
    const entries = await readdir(destinationDir);
    expect(entries).toContain("database.sqlite");
  });

  it("restoreBackup refuses to extract directly into the live PLANTLAB_ROOT_DIR", async () => {
    const { dbPath, dataRoot, backupDir } = await makeFixture();
    const backup = await createBackup({ databaseUrl: `file:${dbPath}`, dataRoot, backupDir });

    const { resolveRootDir } = await import("../../src/lib/paths.server");
    await expect(restoreBackup(backup.archivePath, resolveRootDir())).rejects.toThrow(/live PlantLab root/i);
  });
});
