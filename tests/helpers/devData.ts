import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";

export const DEV_IDS = {
  projectId: "dev-visual-project",
  plantId: "dev-visual-plant",
  secondPlantId: "dev-visual-plant-2",
  photoId: "dev-visual-photo",
  secondPhotoId: "dev-visual-photo-2",
  olderPhotoId: "dev-visual-photo-3",
  eventId: "dev-visual-event",
  secondEventId: "dev-visual-event-2",
};

const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

async function writeFixturePhoto(photoPath: string) {
  await writeFile(photoPath, Buffer.from(TINY_JPEG_BASE64, "base64"));
}

export async function seedVisualData() {
  const root = process.cwd();
  const photoDirectory = path.join(root, "data", "playwright", "photos");
  const photoPath = path.join(photoDirectory, "2026-07-10_09-30-00.jpg");
  const secondPhotoPath = path.join(photoDirectory, "2026-07-11_10-00-00.jpg");
  const olderPhotoPath = path.join(photoDirectory, "2026-06-30_16-00-00.jpg");

  await mkdir(photoDirectory, { recursive: true });
  await writeFixturePhoto(photoPath);
  await writeFixturePhoto(secondPhotoPath);
  await writeFixturePhoto(olderPhotoPath);

  await prisma.project.deleteMany({ where: { id: DEV_IDS.projectId } });

  await prisma.project.create({
    data: {
      id: DEV_IDS.projectId,
      name: "Playwright Radish Study",
      description: "Deterministic visual inspection project",
      gridWidth: 3,
      gridHeight: 3,
      photoIntervalMinutes: 30,
      captureStartAt: new Date("2026-07-10T13:00:00.000Z"),
      localPhotoDirectory: photoDirectory,
      cameraDevice: "/dev/video-test",
      cameraName: "Mock USB Camera",
      plants: {
        create: [
          {
            id: DEV_IDS.plantId,
            name: "Radish A",
            tags: "control, fast",
            notes: "Strong early growth.",
            gridX: 0,
            gridY: 0,
          },
          {
            id: DEV_IDS.secondPlantId,
            name: "Radish B",
            tags: "selective",
            notes: "Marked for comparison.",
            gridX: 1,
            gridY: 0,
          },
        ],
      },
      photos: {
        create: [
          {
          id: DEV_IDS.photoId,
          filename: "2026-07-10_09-30-00.jpg",
          path: photoPath,
          timestamp: new Date("2026-07-10T13:30:00.000Z"),
          notes: "Seed fixture photo.",
          },
          {
            id: DEV_IDS.secondPhotoId,
            filename: "2026-07-11_10-00-00.jpg",
            path: secondPhotoPath,
            timestamp: new Date("2026-07-11T14:00:00.000Z"),
            notes: null,
          },
          {
            id: DEV_IDS.olderPhotoId,
            filename: "2026-06-30_16-00-00.jpg",
            path: olderPhotoPath,
            timestamp: new Date("2026-06-30T20:00:00.000Z"),
            notes: null,
          },
        ],
      },
    },
  });

  await prisma.plantEvent.createMany({
    data: [
      {
        id: DEV_IDS.eventId,
        projectId: DEV_IDS.projectId,
        plantId: DEV_IDS.plantId,
        photoId: DEV_IDS.photoId,
        type: "Germinated",
        notes: "First visible sprout.",
        timestamp: new Date("2026-07-10T13:30:00.000Z"),
      },
      {
        id: DEV_IDS.secondEventId,
        projectId: DEV_IDS.projectId,
        plantId: DEV_IDS.plantId,
        photoId: null,
        type: "Cotyledons",
        notes: "Recorded from manual inspection.",
        timestamp: new Date("2026-07-10T15:00:00.000Z"),
      },
    ],
  });

  return {
    ...DEV_IDS,
    photoDirectory,
    photoPath,
  };
}

export async function disconnectPrisma() {
  await prisma.$disconnect();
}

export async function mockCameraApis(page: Page) {
  await page.route("**/api/cameras", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cameras: [
          {
            name: "Mock USB Camera",
            device: "/dev/video-test",
            supportsCapture: true,
          },
        ],
      }),
    });
  });

  await page.route("**/api/projects/*/camera/controls", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated: true, controls: mockControls() }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ controls: mockControls() }),
    });
  });

  await page.route("**/api/projects/*/camera/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: Buffer.from(TINY_JPEG_BASE64, "base64"),
    });
  });
}

function mockControls() {
  return [
    {
      id: "focus_auto",
      name: "Focus Auto",
      type: "bool",
      value: true,
      readOnly: false,
    },
    {
      id: "focus_absolute",
      name: "Focus Absolute",
      type: "int",
      value: 20,
      minimum: 0,
      maximum: 255,
      step: 5,
      readOnly: false,
    },
    {
      id: "exposure_auto",
      name: "Exposure Auto",
      type: "menu",
      value: 3,
      readOnly: false,
      options: [
        { value: 1, label: "Manual Mode" },
        { value: 3, label: "Aperture Priority Mode" },
      ],
    },
    {
      id: "brightness",
      name: "Brightness",
      type: "int",
      value: 128,
      minimum: 0,
      maximum: 255,
      step: 1,
      readOnly: false,
    },
  ];
}
