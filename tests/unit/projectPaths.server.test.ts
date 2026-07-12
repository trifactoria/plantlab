import { randomUUID } from "node:crypto";
import { access, constants, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultCaptureSourceDirectory,
  defaultProjectPhotoDirectory,
  ensureDirectoryExists,
  isDirectoryUsable,
} from "../../src/lib/projectPaths.server";

describe("projectPaths.server", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function isolatedRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-projectpaths-"));
    tempRoots.push(root);
    vi.stubEnv("PLANTLAB_ROOT_DIR", root);
    return root;
  }

  describe("resolvers are pure (no filesystem side effects)", () => {
    it("defaultProjectPhotoDirectory does not create anything on disk", async () => {
      const root = await isolatedRoot();
      const projectId = randomUUID();
      const resolved = defaultProjectPhotoDirectory(projectId);

      expect(resolved).toBe(path.join(root, "data", "projects", projectId, "photos"));
      await expect(access(resolved)).rejects.toThrow();
      await expect(access(path.join(root, "data", "projects", projectId))).rejects.toThrow();
      await expect(access(path.join(root, "data", "projects"))).rejects.toThrow();
    });

    it("defaultCaptureSourceDirectory does not create anything on disk", async () => {
      const root = await isolatedRoot();
      const sourceId = randomUUID();
      const resolved = defaultCaptureSourceDirectory(sourceId);

      expect(resolved).toBe(path.join(root, "data", "capture-sources", sourceId, "source-photos"));
      await expect(access(resolved)).rejects.toThrow();
    });

    it("calling a resolver many times never creates anything", async () => {
      const root = await isolatedRoot();
      for (let i = 0; i < 5; i += 1) {
        defaultProjectPhotoDirectory(randomUUID());
      }
      await expect(access(path.join(root, "data"))).rejects.toThrow();
    });
  });

  describe("ensureDirectoryExists", () => {
    it("creates a directory (and any missing parents) that did not exist", async () => {
      const root = await isolatedRoot();
      const target = defaultProjectPhotoDirectory(randomUUID());

      await ensureDirectoryExists(target);

      await expect(access(target, constants.W_OK)).resolves.toBeUndefined();
      void root;
    });

    it("is idempotent - calling it twice on the same path does not throw", async () => {
      await isolatedRoot();
      const target = defaultProjectPhotoDirectory(randomUUID());

      await ensureDirectoryExists(target);
      await expect(ensureDirectoryExists(target)).resolves.toBeUndefined();
    });
  });

  describe("isDirectoryUsable", () => {
    it("is true for a directory that already exists and is writable", async () => {
      const root = await isolatedRoot();
      await mkdir(path.join(root, "existing"), { recursive: true });

      await expect(isDirectoryUsable(path.join(root, "existing"))).resolves.toBe(true);
    });

    it("is true for a deeply nested path that doesn't exist yet, as long as an ancestor (even several levels up) is writable", async () => {
      await isolatedRoot();
      const target = defaultProjectPhotoDirectory(randomUUID());

      await expect(isDirectoryUsable(target)).resolves.toBe(true);
      // And crucially, checking it must not have created it.
      await expect(access(target)).rejects.toThrow();
    });

    it("is false for a path whose existing directory is not writable", async () => {
      const root = await isolatedRoot();
      const readonlyDir = path.join(root, "readonly");
      await mkdir(readonlyDir, { recursive: true });
      await import("node:fs/promises").then((fs) => fs.chmod(readonlyDir, 0o555));

      try {
        await expect(isDirectoryUsable(readonlyDir)).resolves.toBe(false);
      } finally {
        await import("node:fs/promises").then((fs) => fs.chmod(readonlyDir, 0o755));
      }
    });

    it("is false for a file path where a directory is expected", async () => {
      const root = await isolatedRoot();
      const filePath = path.join(root, "im-a-file");
      await writeFile(filePath, "x");

      await expect(isDirectoryUsable(path.join(filePath, "nested"))).resolves.toBe(false);
    });
  });
});
