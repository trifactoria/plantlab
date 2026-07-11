import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { PATCH as patchMilestone } from "../../src/app/api/project-milestones/[milestoneId]/route";
import { POST as postProject } from "../../src/app/api/projects/route";
import { POST as postEvent } from "../../src/app/api/events/route";
import { PUT as putHarvestResult } from "../../src/app/api/plants/[plantId]/harvest-result/route";
import { seedDefaultProjectMilestones } from "../../src/lib/experiment";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("experiment routes", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup() {
    const project = await createTestProject(prisma, { captureEnabled: false });
    await seedDefaultProjectMilestones(prisma, project.id);
    const plant = await createTestPlant(prisma, project.id);
    const { photo, directory } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-11T10:00:00Z"),
    });
    cleanup.push(async () => {
      await prisma.plantHarvestResult.deleteMany({ where: { plantId: plant.id } });
      await cleanupTestProject(prisma, project.id, project.localPhotoDirectory);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    });
    return { project, plant, photo };
  }

  it("seeds default milestones when creating a project", async () => {
    const response = await postProject(
      jsonRequest("http://localhost/api/projects", {
        name: "Milestone Seed Test",
        description: "",
        gridWidth: 1,
        gridHeight: 1,
        photoIntervalMinutes: 30,
        captureStartAt: "2026-07-11T10:00:00.000Z",
        plantedAt: "2026-07-10T10:00:00.000Z",
        useDefaultPhotoDirectory: true,
        cameraDevice: "",
      }),
    );
    expect(response.status).toBe(201);
    const project = await response.json();
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));

    const milestones = await prisma.projectMilestone.findMany({
      where: { projectId: project.id },
      orderBy: { sortOrder: "asc" },
    });
    expect(milestones.map((milestone) => milestone.key)).toEqual([
      "first_visible",
      "cotyledons_open",
      "first_true_leaf",
      "root_shoulder_visible",
      "harvest_ready",
      "harvested",
    ]);
  });

  it("renames and reorders a milestone while syncing canonical event type", async () => {
    const { plant, photo, project } = await setup();
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });
    await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        photoId: photo.id,
        milestoneId: milestone.id,
        type: milestone.label,
        timestamp: photo.timestamp,
      },
    });

    const response = await patchMilestone(
      jsonRequest(`http://localhost/api/project-milestones/${milestone.id}`, {
        label: "Visible sprout",
        sortOrder: 9,
        enabled: false,
      }, "PATCH"),
      { params: Promise.resolve({ milestoneId: milestone.id }) },
    );
    expect(response.status).toBe(200);
    const updatedEvent = await prisma.plantEvent.findFirstOrThrow({ where: { plantId: plant.id } });
    expect(updatedEvent.type).toBe("Visible sprout");
  });

  it("creates canonical events with photo timestamp defaults and copied PlantPhotoCrop", async () => {
    const { plant, photo, project } = await setup();
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_true_leaf" },
    });
    await prisma.plantPhotoCrop.create({
      data: { plantId: plant.id, photoId: photo.id, cropX: 0.1, cropY: 0.2, cropWidth: 0.3, cropHeight: 0.4 },
    });

    const response = await postEvent(
      jsonRequest("http://localhost/api/events", {
        plantId: plant.id,
        photoId: photo.id,
        milestoneId: milestone.id,
        copyPlantPhotoCrop: true,
      }),
    );
    expect(response.status).toBe(201);
    const event = await response.json();
    expect(event.type).toBe("First true leaf");
    expect(event.timestamp).toBe(photo.timestamp.toISOString());
    expect(event.cropX).toBe(0.1);
  });

  it("returns a duplicate milestone warning until explicitly confirmed", async () => {
    const { plant, photo, project } = await setup();
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });
    await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        photoId: photo.id,
        milestoneId: milestone.id,
        type: milestone.label,
        timestamp: photo.timestamp,
      },
    });

    const warning = await postEvent(
      jsonRequest("http://localhost/api/events", {
        plantId: plant.id,
        photoId: photo.id,
        milestoneId: milestone.id,
      }),
    );
    expect(warning.status).toBe(409);
    expect((await warning.json()).warnings[0]).toMatch(/already has/);

    const confirmed = await postEvent(
      jsonRequest("http://localhost/api/events", {
        plantId: plant.id,
        photoId: photo.id,
        milestoneId: milestone.id,
        confirmWarnings: true,
      }),
    );
    expect(confirmed.status).toBe(201);
  });

  it("saves harvest results and warns on invalid chronology", async () => {
    const { plant } = await setup();
    const context = { params: Promise.resolve({ plantId: plant.id }) };

    const warning = await putHarvestResult(
      jsonRequest("http://localhost/api/plants/x/harvest-result", {
        harvestedAt: new Date(plant.startedAt.getTime() - 60_000).toISOString(),
        rootWeightGrams: 12,
      }, "PUT"),
      context,
    );
    expect(warning.status).toBe(409);

    const saved = await putHarvestResult(
      jsonRequest("http://localhost/api/plants/x/harvest-result", {
        harvestedAt: new Date(plant.startedAt.getTime() + 86_400_000).toISOString(),
        rootWeightGrams: 12,
        rootDiameterMm: 22,
        acceptable: true,
        confirmWarnings: true,
      }, "PUT"),
      context,
    );
    expect(saved.status).toBe(200);
    const payload = await saved.json();
    expect(payload.rootWeightGrams).toBe(12);
  });
});
