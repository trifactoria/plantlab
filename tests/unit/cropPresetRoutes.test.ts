import { afterEach, describe, expect, it } from "vitest";
import { GET as getPreset, PUT as putPreset } from "../../src/app/api/projects/[projectId]/crop-preset/route";
import { POST as postCropVersion } from "../../src/app/api/plants/[plantId]/crop-versions/route";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

function jsonRequest(url: string, body: unknown, method = "PUT") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

describe("project crop preset route", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup() {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    return { project };
  }

  it("a project without a preset yet continues to work - GET returns null", async () => {
    const { project } = await setup();
    const response = await getPreset(new Request("http://localhost"), context(project.id));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.preset).toBeNull();
  });

  it("saving a preset preserves normalized width, height, and aspect ratio exactly", async () => {
    const { project } = await setup();

    const response = await putPreset(
      jsonRequest(`http://localhost/api/projects/${project.id}/crop-preset`, {
        width: 0.2,
        height: 0.35,
        aspectRatioMode: "9:16",
      }),
      context(project.id),
    );
    expect(response.status).toBe(200);
    const preset = await response.json();
    expect(preset.width).toBe(0.2);
    expect(preset.height).toBe(0.35);
    expect(preset.aspectRatioMode).toBe("9:16");

    // Same normalized values regardless of what pixel resolution any given
    // source photo happens to be - the preset never stores pixel dimensions.
    expect(preset).not.toHaveProperty("widthPx");
    expect(preset).not.toHaveProperty("heightPx");
  });

  it("saving a new preset replaces the previous one rather than creating a second row", async () => {
    const { project } = await setup();
    await putPreset(
      jsonRequest(`http://localhost/api/projects/${project.id}/crop-preset`, {
        width: 0.2,
        height: 0.2,
        aspectRatioMode: "1:1",
      }),
      context(project.id),
    );
    await putPreset(
      jsonRequest(`http://localhost/api/projects/${project.id}/crop-preset`, {
        width: 0.3,
        height: 0.4,
        aspectRatioMode: "16:9",
      }),
      context(project.id),
    );

    const count = await prisma.projectCropPreset.count({ where: { projectId: project.id } });
    expect(count).toBe(1);

    const response = await getPreset(new Request("http://localhost"), context(project.id));
    const payload = await response.json();
    expect(payload.preset.width).toBe(0.3);
    expect(payload.preset.aspectRatioMode).toBe("16:9");
  });

  it("presets do not leak between projects", async () => {
    const { project: projectA } = await setup();
    const projectB = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, projectB.id, projectB.localPhotoDirectory));

    await putPreset(
      jsonRequest(`http://localhost/api/projects/${projectA.id}/crop-preset`, {
        width: 0.25,
        height: 0.25,
        aspectRatioMode: "1:1",
      }),
      context(projectA.id),
    );

    const responseB = await getPreset(new Request("http://localhost"), context(projectB.id));
    const payloadB = await responseB.json();
    expect(payloadB.preset).toBeNull();
  });

  it("creating a crop version never modifies the project preset (moving/resizing during normal use doesn't touch it)", async () => {
    const { project } = await setup();
    const plant = await createTestPlant(prisma, project.id);
    const { photo, directory } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-01T10:00:00.000Z"),
    });
    cleanup.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    });

    await putPreset(
      jsonRequest(`http://localhost/api/projects/${project.id}/crop-preset`, {
        width: 0.2,
        height: 0.2,
        aspectRatioMode: "1:1",
      }),
      context(project.id),
    );

    // Draw and save a differently-sized/positioned crop as this plant's
    // initial crop - an ordinary "Set initial crop", not "Save size as
    // project default".
    await postCropVersion(
      jsonRequest(
        `http://localhost/api/plants/${plant.id}/crop-versions`,
        {
          sourcePhotoId: photo.id,
          cropX: 0.5,
          cropY: 0.5,
          cropWidth: 0.4,
          cropHeight: 0.4,
          aspectRatioMode: "16:9",
        },
        "POST",
      ),
      { params: Promise.resolve({ plantId: plant.id }) },
    );

    const response = await getPreset(new Request("http://localhost"), context(project.id));
    const payload = await response.json();
    expect(payload.preset.width).toBe(0.2);
    expect(payload.preset.height).toBe(0.2);
    expect(payload.preset.aspectRatioMode).toBe("1:1");
  });
});
