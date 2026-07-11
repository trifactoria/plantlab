import { afterEach, describe, expect, it } from "vitest";
import { POST as postPlant } from "../../src/app/api/plants/route";
import { PATCH as patchPlant } from "../../src/app/api/plants/[plantId]/route";
import { POST as postEvent } from "../../src/app/api/events/route";
import { seedDefaultProjectMilestones } from "../../src/lib/experiment";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("plants routes", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup() {
    const project = await createTestProject(prisma);
    await seedDefaultProjectMilestones(prisma, project.id);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    return { project };
  }

  it("creates a plant without a starting observation and records it as Added to project", async () => {
    const { project } = await setup();

    const response = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "R1",
        startedAt: "2026-07-11T10:00:00.000Z",
      }),
    );

    expect(response.status).toBe(201);
    const plant = await response.json();
    expect(plant.startLabel).toBe("Added to project");

    const events = await prisma.plantEvent.findMany({ where: { plantId: plant.id } });
    expect(events).toHaveLength(0);
  });

  it("creates a plant with a custom starting observation as a normal PlantEvent", async () => {
    const { project } = await setup();

    const plantResponse = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "Radish 5",
        startedAt: "2026-07-11T10:00:00.000Z",
      }),
    );
    expect(plantResponse.status).toBe(201);
    const plant = await plantResponse.json();
    expect(plant.startLabel).toBe("Added to project");

    const eventResponse = await postEvent(
      jsonRequest("http://localhost/api/events", {
        plantId: plant.id,
        timestamp: "2026-07-11T10:00:00.000Z",
        type: "Cutting placed in water",
      }),
    );
    expect(eventResponse.status).toBe(201);
    const event = await eventResponse.json();
    expect(event.type).toBe("Cutting placed in water");
    expect(event.milestoneId).toBeNull();
  });

  it("creates a plant with a starting observation linked to a project milestone", async () => {
    const { project } = await setup();
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });

    const plantResponse = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "R2",
        startedAt: "2026-07-11T10:00:00.000Z",
      }),
    );
    expect(plantResponse.status).toBe(201);
    const plant = await plantResponse.json();

    const eventResponse = await postEvent(
      jsonRequest("http://localhost/api/events", {
        plantId: plant.id,
        timestamp: "2026-07-11T10:00:00.000Z",
        milestoneId: milestone.id,
      }),
    );
    expect(eventResponse.status).toBe(201);
    const event = await eventResponse.json();
    expect(event.milestoneId).toBe(milestone.id);
    expect(event.type).toBe(milestone.label);
  });

  it("still supports editing an existing plant's start label and timestamp", async () => {
    const { project } = await setup();

    const plantResponse = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "Legacy Plant",
        startLabel: "First visible",
        startedAt: "2026-07-01T10:00:00.000Z",
      }),
    );
    const plant = await plantResponse.json();
    expect(plant.startLabel).toBe("First visible");

    const patchResponse = await patchPlant(
      jsonRequest(
        `http://localhost/api/plants/${plant.id}`,
        {
          name: "Legacy Plant",
          startLabel: "Cutting planted in soil",
          startedAt: "2026-07-02T10:00:00.000Z",
        },
        "PATCH",
      ),
      { params: Promise.resolve({ plantId: plant.id }) },
    );
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();
    expect(updated.startLabel).toBe("Cutting planted in soil");
    expect(new Date(updated.startedAt).toISOString()).toBe("2026-07-02T10:00:00.000Z");
  });
});
