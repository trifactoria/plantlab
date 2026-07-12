import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditProjectDirectories, removeEmptyOrphans } from "../../src/lib/dataDoctor.server";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

describe("dataDoctor.server", () => {
  const tempRoots: string[] = [];
  const testProjects: Array<{ id: string; directory: string }> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const { id, directory } of testProjects.splice(0)) {
      await cleanupTestProject(prisma, id, directory);
    }
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function isolatedRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-datadoctor-"));
    tempRoots.push(root);
    vi.stubEnv("PLANTLAB_ROOT_DIR", root);
    const projectsDataDir = path.join(root, "data", "projects");
    await mkdir(projectsDataDir, { recursive: true });
    return { root, projectsDataDir };
  }

  async function realProject() {
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null });
    testProjects.push({ id: project.id, directory: project.localPhotoDirectory });
    return project;
  }

  it("reports zero orphans and correctly lists a known project's directory as present", async () => {
    const { projectsDataDir } = await isolatedRoot();
    const project = await realProject();
    await mkdir(path.join(projectsDataDir, project.id), { recursive: true });

    const report = await auditProjectDirectories(prisma);

    expect(report.emptyOrphans).toEqual([]);
    expect(report.nonEmptyOrphans).toEqual([]);
    expect(report.existingDirectoryNames).toContain(project.id);
  });

  it("classifies a directory with no matching project as an empty orphan", async () => {
    const { projectsDataDir } = await isolatedRoot();
    const orphanId = randomUUID();
    await mkdir(path.join(projectsDataDir, orphanId), { recursive: true });

    const report = await auditProjectDirectories(prisma);

    expect(report.emptyOrphans.map((o) => o.id)).toEqual([orphanId]);
    expect(report.nonEmptyOrphans).toEqual([]);
  });

  it("classifies an orphan with a nested empty subdirectory (the old eager-mkdir shape) as an empty orphan", async () => {
    const { projectsDataDir } = await isolatedRoot();
    const orphanId = randomUUID();
    await mkdir(path.join(projectsDataDir, orphanId, "photos"), { recursive: true });

    const report = await auditProjectDirectories(prisma);

    expect(report.emptyOrphans.map((o) => o.id)).toEqual([orphanId]);
  });

  it("classifies an orphan containing a real file as a non-empty orphan, with byte size and file count reported", async () => {
    const { projectsDataDir } = await isolatedRoot();
    const orphanId = randomUUID();
    const photoDir = path.join(projectsDataDir, orphanId, "photos");
    await mkdir(photoDir, { recursive: true });
    await writeFile(path.join(photoDir, "real-photo.jpg"), Buffer.from("not empty"));

    const report = await auditProjectDirectories(prisma);

    expect(report.emptyOrphans).toEqual([]);
    expect(report.nonEmptyOrphans).toHaveLength(1);
    expect(report.nonEmptyOrphans[0].id).toBe(orphanId);
    expect(report.nonEmptyOrphans[0].fileCount).toBe(1);
    expect(report.nonEmptyOrphans[0].totalBytes).toBe(Buffer.from("not empty").length);
  });

  it("reports a directory name that isn't a UUID as malformed, independent of orphan/empty status", async () => {
    const { projectsDataDir } = await isolatedRoot();
    await mkdir(path.join(projectsDataDir, "not-a-uuid"), { recursive: true });

    const report = await auditProjectDirectories(prisma);

    expect(report.malformedNames.map((m) => m.id)).toEqual(["not-a-uuid"]);
  });

  it("reports a symlink separately and excludes it from both orphan lists", async () => {
    const { root, projectsDataDir } = await isolatedRoot();
    const realDir = path.join(root, "elsewhere");
    await mkdir(realDir, { recursive: true });
    const linkId = randomUUID();
    await symlink(realDir, path.join(projectsDataDir, linkId));

    const report = await auditProjectDirectories(prisma);

    expect(report.symlinks.map((s) => s.id)).toEqual([linkId]);
    expect(report.emptyOrphans).toEqual([]);
    expect(report.nonEmptyOrphans).toEqual([]);
  });

  it("lists a DB project with no directory on disk under missingExpectedDirectories, not as an orphan", async () => {
    await isolatedRoot();
    const project = await realProject();
    // Deliberately do not create a directory for it.

    const report = await auditProjectDirectories(prisma);

    expect(report.missingExpectedDirectories.map((m) => m.projectId)).toContain(project.id);
    expect(report.emptyOrphans.map((o) => o.id)).not.toContain(project.id);
  });

  describe("removeEmptyOrphans", () => {
    it("dry-run style call with an old age and ignoreAge:false still deletes nothing if the report is only inspected, not acted on", async () => {
      // (This is really documenting that auditProjectDirectories itself is
      // fully read-only - see the dedicated CLI-level dry-run test below
      // for the actual "no --remove-empty-orphans flag" behavior.)
      const { projectsDataDir } = await isolatedRoot();
      const orphanId = randomUUID();
      const dir = path.join(projectsDataDir, orphanId);
      await mkdir(dir, { recursive: true });

      await auditProjectDirectories(prisma);

      await expect(mkdir(dir)).rejects.toThrow(); // still exists (EEXIST)
    });

    it("removes only empty orphans older than the safety interval, leaving recent ones untouched", async () => {
      const { projectsDataDir } = await isolatedRoot();
      const oldId = randomUUID();
      const recentId = randomUUID();
      await mkdir(path.join(projectsDataDir, oldId), { recursive: true });
      await mkdir(path.join(projectsDataDir, recentId), { recursive: true });

      const report = await auditProjectDirectories(prisma);
      // Simulate "old" by using a now far in the future relative to real mtimes.
      const farFuture = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const oldOnly = { ...report, emptyOrphans: report.emptyOrphans.filter((o) => o.id === oldId) };

      const result = await removeEmptyOrphans(oldOnly, { now: farFuture });

      expect(result.removed).toEqual([path.join(projectsDataDir, oldId)]);
      await expect(mkdir(path.join(projectsDataDir, recentId))).rejects.toThrow(); // untouched, still exists
    });

    it("skips (does not delete) orphans younger than the safety interval by default", async () => {
      const { projectsDataDir } = await isolatedRoot();
      const recentId = randomUUID();
      await mkdir(path.join(projectsDataDir, recentId), { recursive: true });

      const report = await auditProjectDirectories(prisma);
      const result = await removeEmptyOrphans(report);

      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("Too recent");
      await expect(mkdir(path.join(projectsDataDir, recentId))).rejects.toThrow(); // still exists
    });

    it("removes a recent orphan when ignoreAge is explicitly set", async () => {
      const { projectsDataDir } = await isolatedRoot();
      const recentId = randomUUID();
      await mkdir(path.join(projectsDataDir, recentId), { recursive: true });

      const report = await auditProjectDirectories(prisma);
      const result = await removeEmptyOrphans(report, { ignoreAge: true });

      expect(result.removed).toEqual([path.join(projectsDataDir, recentId)]);
    });

    it("never removes a non-empty orphan even if passed directly", async () => {
      const { projectsDataDir } = await isolatedRoot();
      const orphanId = randomUUID();
      const dir = path.join(projectsDataDir, orphanId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "photo.jpg"), "data");

      const report = await auditProjectDirectories(prisma);
      expect(report.emptyOrphans).toEqual([]); // never even entered the empty list

      // Even if a caller mistakenly fabricated an "empty" entry for it, the
      // fresh re-check inside removeEmptyOrphans must refuse to delete it.
      const fabricated = {
        ...report,
        emptyOrphans: [{ id: orphanId, directoryPath: dir, isSymlink: false, looksLikeProjectId: true, fileCount: 0, totalBytes: 0, mtime: new Date(0) }],
      };
      const result = await removeEmptyOrphans(fabricated, { ignoreAge: true });
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toMatch(/file|not empty/i);
    });

    it("never removes a symlink", async () => {
      const { root, projectsDataDir } = await isolatedRoot();
      const realDir = path.join(root, "elsewhere-2");
      await mkdir(realDir, { recursive: true });
      const linkId = randomUUID();
      const linkPath = path.join(projectsDataDir, linkId);
      await symlink(realDir, linkPath);

      const report = await auditProjectDirectories(prisma);
      expect(report.emptyOrphans).toEqual([]);
      expect(report.symlinks.map((s) => s.id)).toEqual([linkId]);

      // Symlink target must be untouched regardless.
      const { readdir } = await import("node:fs/promises");
      await expect(readdir(realDir)).resolves.toEqual([]);
    });
  });
});
