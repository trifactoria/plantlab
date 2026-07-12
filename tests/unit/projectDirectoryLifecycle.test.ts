import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteProject } from "../../src/app/api/projects/[projectId]/route";
import { POST as postProject } from "../../src/app/api/projects/route";
import { defaultProjectPhotoDirectory, ensureDirectoryExists } from "../../src/lib/projectPaths.server";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject } from "./helpers/testProject";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

/**
 * Regression coverage for the empty-orphan-directory bug: creating a
 * project (or checking its capture eligibility) must never touch the
 * filesystem - only an actual capture/upload does, via
 * ensureDirectoryExists(). See src/lib/dataDoctor.server.ts and
 * DEPLOYMENT.md for the full diagnosis.
 */
describe("project directory lifecycle", () => {
  const tempRoots: string[] = [];
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
    vi.unstubAllEnvs();
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function isolatedRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-lifecycle-"));
    tempRoots.push(root);
    vi.stubEnv("PLANTLAB_ROOT_DIR", root);
    return root;
  }

  it("creating a project via the API does not create its photo directory on disk", async () => {
    await isolatedRoot();

    const response = await postProject(
      jsonRequest("http://localhost/api/projects", {
        name: "Lifecycle Test - default dir",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 30,
        useDefaultPhotoDirectory: true,
      }),
    );
    expect(response.status).toBe(201);
    const project = await response.json();
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));

    expect(project.localPhotoDirectory).toBe(defaultProjectPhotoDirectory(project.id));
    await expect(access(project.localPhotoDirectory)).rejects.toThrow();
    // Not even the parent <id>/ directory should exist.
    await expect(access(path.dirname(project.localPhotoDirectory))).rejects.toThrow();
  });

  it("creating a project with an unusable custom directory fails and leaves neither a DB row nor a directory", async () => {
    const root = await isolatedRoot();
    const blockingFile = path.join(root, "blocking-file");
    await writeFile(blockingFile, "x");
    const unusableDirectory = path.join(blockingFile, "nested", "photos");

    const before = await prisma.project.count();

    const response = await postProject(
      jsonRequest("http://localhost/api/projects", {
        name: "Lifecycle Test - unusable dir",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 30,
        useDefaultPhotoDirectory: false,
        localPhotoDirectory: unusableDirectory,
      }),
    );

    expect(response.status).toBe(400);
    const after = await prisma.project.count();
    expect(after).toBe(before);
    await expect(access(unusableDirectory)).rejects.toThrow();
  });

  it("deleting a project preserves its photo directory and contents (existing intended policy)", async () => {
    await isolatedRoot();

    const response = await postProject(
      jsonRequest("http://localhost/api/projects", {
        name: "Lifecycle Test - delete preserves photos",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 30,
        useDefaultPhotoDirectory: true,
      }),
    );
    const project = await response.json();

    // Simulate a real capture having happened.
    await ensureDirectoryExists(project.localPhotoDirectory);
    const photoPath = path.join(project.localPhotoDirectory, "real-photo.jpg");
    await writeFile(photoPath, "real photo bytes");

    const deleteResponse = await deleteProject(new Request("http://localhost", { method: "DELETE" }), context(project.id));
    expect(deleteResponse.status).toBe(200);
    const deletePayload = await deleteResponse.json();
    expect(deletePayload.preservedPhotoDirectory).toBe(project.localPhotoDirectory);

    expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
    // The directory and its real content must still exist on disk.
    await expect(access(photoPath)).resolves.toBeUndefined();

    cleanup.push(() => rm(project.localPhotoDirectory, { recursive: true, force: true }).catch(() => undefined));
  });

  it("a directory that never received a real capture stays absent even after the project is later deleted", async () => {
    await isolatedRoot();

    const response = await postProject(
      jsonRequest("http://localhost/api/projects", {
        name: "Lifecycle Test - create then delete, never captured",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 30,
        useDefaultPhotoDirectory: true,
      }),
    );
    const project = await response.json();

    const deleteResponse = await deleteProject(new Request("http://localhost", { method: "DELETE" }), context(project.id));
    expect(deleteResponse.status).toBe(200);

    // This is the exact scenario that used to leave an empty orphan
    // directory behind (e.g. every e2e test's throwaway project): it never
    // existed in the first place now, so there's nothing left to orphan.
    await expect(access(project.localPhotoDirectory)).rejects.toThrow();
    await expect(access(path.dirname(project.localPhotoDirectory))).rejects.toThrow();
  });

  it("ensureDirectoryExists is what actually creates the directory a capture writes into", async () => {
    await isolatedRoot();
    const projectId = "vitest-lifecycle-manual";
    const directory = defaultProjectPhotoDirectory(projectId);

    await expect(access(directory)).rejects.toThrow();
    await ensureDirectoryExists(directory);
    await expect(access(directory)).resolves.toBeUndefined();

    await mkdir(directory, { recursive: true }); // idempotent, matches real capture retry behavior
  });
});
