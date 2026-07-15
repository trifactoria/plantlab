import { afterEach, describe, expect, it } from "vitest";
import { POST as postProject } from "../../src/app/api/projects/route";
import { PATCH as patchProject } from "../../src/app/api/projects/[projectId]/route";
import { POST as capturePhoto } from "../../src/app/api/projects/[projectId]/photos/capture/route";
import { prisma } from "../../src/lib/prisma";
import { cleanupVisualData, seedVisualData } from "../helpers/devData";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("test project safety", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
    await cleanupVisualData();
  });

  it("rejects test projects that try to enable scheduled capture through the create API", async () => {
    const response = await postProject(
      jsonRequest("http://localhost/api/projects", {
        name: "Test Capture Block",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 30,
        captureStartAt: "2026-07-11T10:00:00.000Z",
        timeZone: "America/New_York",
        useDefaultPhotoDirectory: true,
        captureEnabled: true,
        isTestProject: true,
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Test projects cannot enable scheduled capture");
  });

  it("rejects enabling scheduled capture on an existing test project", async () => {
    const project = await createTestProject(prisma, {
      captureEnabled: false,
      isTestProject: true,
      cameraDevice: "/dev/video-test",
    });
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));

    const response = await patchProject(
      jsonRequest(`http://localhost/api/projects/${project.id}`, { captureEnabled: true }, "PATCH"),
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Test projects cannot enable scheduled capture");
  });

  it("rejects manual physical camera capture for test projects", async () => {
    const project = await createTestProject(prisma, {
      captureEnabled: false,
      isTestProject: true,
      cameraDevice: "/dev/video-test",
    });
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));

    const response = await capturePhoto(
      jsonRequest(`http://localhost/api/projects/${project.id}/photos/capture`, {}),
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(403);
  });

  it("creates Playwright fixtures as non-capturable test projects without a real camera", async () => {
    const ids = await seedVisualData();
    const project = await prisma.project.findUniqueOrThrow({ where: { id: ids.projectId } });

    expect(project.isTestProject).toBe(true);
    expect(project.captureEnabled).toBe(false);
    expect(project.cameraDevice).toBeNull();
  });
});
