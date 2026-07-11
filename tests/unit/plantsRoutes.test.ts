import { afterEach, describe, expect, it } from "vitest";
import { POST as postPlant } from "../../src/app/api/plants/route";
import { PATCH as patchPlant } from "../../src/app/api/plants/[plantId]/route";
import { ensurePlantOriginEvents, seedDefaultProjectMilestones } from "../../src/lib/experiment";
import { EVENT_KIND_ORIGIN, ORIGIN_EVENT_TYPE } from "../../src/lib/observationKinds";
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

  it("creates exactly one origin event and no observation event when none is supplied", async () => {
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
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe(EVENT_KIND_ORIGIN);
    expect(events[0].type).toBe(ORIGIN_EVENT_TYPE);
    expect(events[0].milestoneId).toBeNull();
    expect(events[0].timestamp.toISOString()).toBe("2026-07-11T10:00:00.000Z");
  });

  it("creates a plant with a custom starting observation as a separate second PlantEvent", async () => {
    const { project } = await setup();

    const response = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "Radish 5",
        startedAt: "2026-07-11T10:00:00.000Z",
        startingObservation: { type: "Cutting placed in water" },
      }),
    );
    expect(response.status).toBe(201);
    const plant = await response.json();
    expect(plant.startLabel).toBe("Added to project");

    const events = await prisma.plantEvent.findMany({
      where: { plantId: plant.id },
      orderBy: { kind: "asc" },
    });
    expect(events).toHaveLength(2);

    const origin = events.find((event) => event.kind === EVENT_KIND_ORIGIN);
    const observation = events.find((event) => event.kind === "observation");
    expect(origin?.type).toBe(ORIGIN_EVENT_TYPE);
    expect(observation?.type).toBe("Cutting placed in water");
    expect(observation?.milestoneId).toBeNull();
  });

  it("creates a plant with a starting observation linked to a project milestone, atomically", async () => {
    const { project } = await setup();
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });

    const response = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "R2",
        startedAt: "2026-07-11T10:00:00.000Z",
        startingObservation: { milestoneId: milestone.id },
      }),
    );
    expect(response.status).toBe(201);
    const plant = await response.json();

    const events = await prisma.plantEvent.findMany({ where: { plantId: plant.id } });
    expect(events).toHaveLength(2);
    const observation = events.find((event) => event.kind === "observation");
    expect(observation?.milestoneId).toBe(milestone.id);
    expect(observation?.type).toBe(milestone.label);
  });

  it("is atomic: an invalid starting observation milestone creates neither the plant nor any event", async () => {
    const { project } = await setup();

    const response = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "Should Not Exist",
        startedAt: "2026-07-11T10:00:00.000Z",
        startingObservation: { milestoneId: "does-not-exist" },
      }),
    );

    expect(response.status).toBe(400);

    const plant = await prisma.plant.findUnique({
      where: { projectId_gridX_gridY: { projectId: project.id, gridX: 0, gridY: 0 } },
    });
    expect(plant).toBeNull();

    const events = await prisma.plantEvent.findMany({ where: { projectId: project.id } });
    expect(events).toHaveLength(0);
  });

  it("backfills a missing origin event idempotently for legacy plants", async () => {
    const { project } = await setup();
    const legacyPlant = await prisma.plant.create({
      data: {
        projectId: project.id,
        name: "Legacy Plant",
        gridX: 0,
        gridY: 0,
        startedAt: new Date("2026-06-01T08:00:00.000Z"),
        startLabel: "First visible",
      },
    });

    await ensurePlantOriginEvents(prisma, project.id);
    await ensurePlantOriginEvents(prisma, project.id);

    const events = await prisma.plantEvent.findMany({
      where: { plantId: legacyPlant.id, kind: EVENT_KIND_ORIGIN },
    });
    expect(events).toHaveLength(1);
    expect(events[0].timestamp.toISOString()).toBe("2026-06-01T08:00:00.000Z");
    expect(events[0].type).toBe(ORIGIN_EVENT_TYPE);
    // Legacy startLabel is preserved untouched - see src/lib/observationKinds.ts.
    expect(legacyPlant.startLabel).toBe("First visible");
  });

  it("still supports the internal startLabel/startedAt PATCH capability used for compatibility", async () => {
    const { project } = await setup();

    const plantResponse = await postPlant(
      jsonRequest("http://localhost/api/plants", {
        projectId: project.id,
        gridX: 0,
        gridY: 0,
        name: "Legacy Plant",
        startedAt: "2026-07-01T10:00:00.000Z",
      }),
    );
    const plant = await plantResponse.json();
    expect(plant.startLabel).toBe("Added to project");

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
