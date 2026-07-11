import { afterEach, describe, expect, it } from "vitest";
import { PATCH as patchEvent, DELETE as deleteEvent } from "../../src/app/api/events/[eventId]/route";
import { POST as postPlant } from "../../src/app/api/plants/route";
import { seedDefaultProjectMilestones } from "../../src/lib/experiment";
import { EVENT_KIND_ORIGIN } from "../../src/lib/observationKinds";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

function jsonRequest(url: string, body: unknown, method = "PATCH") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

describe("event edit/delete routes", () => {
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

  async function createPlantWithOrigin(projectId: string, overrides: Record<string, unknown> = {}) {
    const response = await postPlant(
      new Request("http://localhost/api/plants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          gridX: 0,
          gridY: 0,
          name: "Test Plant",
          startedAt: "2026-07-11T10:00:00.000Z",
          ...overrides,
        }),
      }),
    );
    return response.json();
  }

  it("edits a normal event's type, notes, and timestamp", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        type: "Germinated",
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${event.id}`, {
        type: "Cotyledons",
        notes: "Looking healthy.",
        timestamp: "2026-07-13T10:00:00.000Z",
      }),
      context(event.id),
    );
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.type).toBe("Cotyledons");
    expect(updated.notes).toBe("Looking healthy.");
    expect(new Date(updated.timestamp).toISOString()).toBe("2026-07-13T10:00:00.000Z");
  });

  it("edits a milestone event's timestamp while keeping its milestone link", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        milestoneId: milestone.id,
        type: milestone.label,
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${event.id}`, {
        timestamp: "2026-07-13T09:00:00.000Z",
      }),
      context(event.id),
    );
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.milestoneId).toBe(milestone.id);
    expect(updated.type).toBe(milestone.label);
  });

  it("converts a milestone event to a custom observation, clearing its milestone link", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        milestoneId: milestone.id,
        type: milestone.label,
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${event.id}`, {
        milestoneId: null,
        type: "Cutting placed in water",
      }),
      context(event.id),
    );
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.milestoneId).toBeNull();
    expect(updated.type).toBe("Cutting placed in water");
  });

  it("converts a custom observation to a milestone event", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "cotyledons_open" },
    });
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        type: "Cutting placed in water",
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${event.id}`, {
        milestoneId: milestone.id,
      }),
      context(event.id),
    );
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.milestoneId).toBe(milestone.id);
    expect(updated.type).toBe(milestone.label);
  });

  it("edits the starting observation event like any other observation", async () => {
    const { project } = await setup();
    const milestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: project.id, key: "first_visible" },
    });
    const plant = await createPlantWithOrigin(project.id, {
      startingObservation: { milestoneId: milestone.id },
    });
    const observation = await prisma.plantEvent.findFirstOrThrow({
      where: { plantId: plant.id, kind: "observation" },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${observation.id}`, {
        notes: "Updated starting observation notes.",
      }),
      context(observation.id),
    );
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.notes).toBe("Updated starting observation notes.");
    expect(updated.kind).toBe("observation");
  });

  it("editing the origin event's timestamp also updates Plant.startedAt", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const origin = await prisma.plantEvent.findFirstOrThrow({
      where: { plantId: plant.id, kind: EVENT_KIND_ORIGIN },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${origin.id}`, {
        timestamp: "2026-07-05T08:00:00.000Z",
        notes: "Moved into the greenhouse.",
      }),
      context(origin.id),
    );
    expect(response.status).toBe(200);

    const updatedPlant = await prisma.plant.findUniqueOrThrow({ where: { id: plant.id } });
    expect(updatedPlant.startedAt.toISOString()).toBe("2026-07-05T08:00:00.000Z");
  });

  it("rejects changing the origin event's type or milestone", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const origin = await prisma.plantEvent.findFirstOrThrow({
      where: { plantId: plant.id, kind: EVENT_KIND_ORIGIN },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${origin.id}`, { type: "Something else" }),
      context(origin.id),
    );
    expect(response.status).toBe(400);
  });

  it("deletes a normal event", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        type: "Germinated",
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await deleteEvent(new Request(`http://localhost/api/events/${event.id}`, { method: "DELETE" }), context(event.id));
    expect(response.status).toBe(200);
    const remaining = await prisma.plantEvent.findUnique({ where: { id: event.id } });
    expect(remaining).toBeNull();
  });

  it("blocks deleting the origin event", async () => {
    const { project } = await setup();
    const plant = await createPlantWithOrigin(project.id);
    const origin = await prisma.plantEvent.findFirstOrThrow({
      where: { plantId: plant.id, kind: EVENT_KIND_ORIGIN },
    });

    const response = await deleteEvent(
      new Request(`http://localhost/api/events/${origin.id}`, { method: "DELETE" }),
      context(origin.id),
    );
    expect(response.status).toBe(400);
    const stillThere = await prisma.plantEvent.findUnique({ where: { id: origin.id } });
    expect(stillThere).not.toBeNull();
  });

  it("rejects a milestone from a different project", async () => {
    const { project } = await setup();
    const otherProject = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));
    await seedDefaultProjectMilestones(prisma, otherProject.id);
    const foreignMilestone = await prisma.projectMilestone.findFirstOrThrow({
      where: { projectId: otherProject.id, key: "first_visible" },
    });

    const plant = await createPlantWithOrigin(project.id);
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        type: "Germinated",
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${event.id}`, { milestoneId: foreignMilestone.id }),
      context(event.id),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a photo from a different project", async () => {
    const { project } = await setup();
    const otherProject = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, otherProject.id, otherProject.localPhotoDirectory));
    const { photo: foreignPhoto, directory } = await createRealPhoto(prisma, otherProject.id);
    cleanup.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    });

    const plant = await createTestPlant(prisma, project.id);
    const event = await prisma.plantEvent.create({
      data: {
        projectId: project.id,
        plantId: plant.id,
        kind: "observation",
        type: "Germinated",
        timestamp: new Date("2026-07-12T10:00:00.000Z"),
      },
    });

    const response = await patchEvent(
      jsonRequest(`http://localhost/api/events/${event.id}`, { photoId: foreignPhoto.id }),
      context(event.id),
    );
    expect(response.status).toBe(400);
  });
});
