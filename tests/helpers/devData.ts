import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";
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
  profileId: "dev-visual-profile",
  plantCropOlderId: "dev-visual-plant-crop-older",
  plantCropId: "dev-visual-plant-crop",
  plantCropSecondId: "dev-visual-plant-crop-2",
  milestoneFirstVisibleId: "dev-milestone-first-visible",
  milestoneCotyledonsId: "dev-milestone-cotyledons",
  milestoneFirstTrueLeafId: "dev-milestone-first-true-leaf",
  milestoneRootShoulderId: "dev-milestone-root-shoulder",
  milestoneHarvestReadyId: "dev-milestone-harvest-ready",
  milestoneHarvestedId: "dev-milestone-harvested",
};

const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

async function writeFixturePhoto(photoPath: string) {
  const width = 1600;
  const height = 900;
  const gridLines = Array.from({ length: 17 }, (_, index) => {
    const x = index * 100;
    return `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#1f2937" stroke-width="${index % 4 === 0 ? 3 : 1}" opacity="0.7"/>`;
  }).join("");
  const horizontalGridLines = Array.from({ length: 10 }, (_, index) => {
    const y = index * 100;
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#1f2937" stroke-width="${index % 3 === 0 ? 3 : 1}" opacity="0.7"/>`;
  }).join("");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="800" height="450" x="0" y="0" fill="#d9f99d"/>
      <rect width="800" height="450" x="800" y="0" fill="#bfdbfe"/>
      <rect width="800" height="450" x="0" y="450" fill="#fecaca"/>
      <rect width="800" height="450" x="800" y="450" fill="#fde68a"/>
      ${gridLines}
      ${horizontalGridLines}
      <circle cx="800" cy="450" r="150" fill="none" stroke="#111827" stroke-width="18"/>
      <rect x="130" y="110" width="320" height="320" fill="none" stroke="#059669" stroke-width="16"/>
      <rect x="160" y="660" width="640" height="360" transform="translate(0 -170)" fill="none" stroke="#7c3aed" stroke-width="16"/>
      <rect x="1180" y="105" width="270" height="480" fill="none" stroke="#dc2626" stroke-width="16"/>
      <text x="800" y="70" text-anchor="middle" font-family="Arial" font-size="60" font-weight="700" fill="#111827">TOP</text>
      <text x="800" y="860" text-anchor="middle" font-family="Arial" font-size="60" font-weight="700" fill="#111827">BOTTOM</text>
      <text x="55" y="465" text-anchor="middle" font-family="Arial" font-size="48" font-weight="700" fill="#111827" transform="rotate(-90 55 465)">LEFT</text>
      <text x="1545" y="465" text-anchor="middle" font-family="Arial" font-size="48" font-weight="700" fill="#111827" transform="rotate(90 1545 465)">RIGHT</text>
      <text x="480" y="520" text-anchor="middle" font-family="Arial" font-size="38" font-weight="700" fill="#4c1d95">16:9</text>
      <text x="1315" y="625" text-anchor="middle" font-family="Arial" font-size="38" font-weight="700" fill="#7f1d1d">9:16</text>
    </svg>`;
  const buffer = await sharp(Buffer.from(svg))
    .jpeg()
    .toBuffer();
  await writeFile(photoPath, buffer);
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
  await prisma.cameraProfile.deleteMany({ where: { id: DEV_IDS.profileId } });
  await prisma.cameraProfile.create({
    data: {
      id: DEV_IDS.profileId,
      name: "Mock Germination Profile",
      cameraDevice: "/dev/video-test",
      cameraName: "Mock USB Camera",
      cameraStableId: "usb:1234:5678:MOCKSERIAL",
      width: 1920,
      height: 1080,
      inputFormat: "mjpg",
      controlsJson: JSON.stringify({ focus_automatic_continuous: true, brightness: 128 }),
    },
  });

  await prisma.project.create({
    data: {
      id: DEV_IDS.projectId,
      name: "Playwright Radish Study",
      description: "Deterministic visual inspection project",
      gridWidth: 3,
      gridHeight: 3,
      photoIntervalMinutes: 30,
      captureStartAt: new Date("2026-07-10T13:00:00.000Z"),
      captureEnabled: false,
      timeZone: "America/New_York",
      captureWindowEnabled: true,
      captureWindowStartMinutes: 20 * 60,
      captureWindowEndMinutes: 6 * 60,
      isTestProject: true,
      plantedAt: new Date("2026-07-09T12:00:00.000Z"),
      localPhotoDirectory: photoDirectory,
      cameraDevice: null,
      cameraName: null,
      cameraStableId: null,
      cameraProfileId: null,
      plants: {
        create: [
          {
            id: DEV_IDS.plantId,
            name: "Radish A",
            tags: "control, fast",
            notes: "Strong early growth.",
            gridX: 0,
            gridY: 0,
            visualAspectRatio: "16:9",
            startedAt: new Date("2026-07-10T12:00:00.000Z"),
            startLabel: "First visible",
          },
          {
            id: DEV_IDS.secondPlantId,
            name: "Radish B",
            tags: "selective",
            notes: "Marked for comparison.",
            gridX: 1,
            gridY: 0,
            startedAt: new Date("2026-07-10T12:30:00.000Z"),
            startLabel: "Added to project",
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

  await prisma.projectMilestone.createMany({
    data: [
      { id: DEV_IDS.milestoneFirstVisibleId, projectId: DEV_IDS.projectId, key: "first_visible", label: "First visible", sortOrder: 1 },
      { id: DEV_IDS.milestoneCotyledonsId, projectId: DEV_IDS.projectId, key: "cotyledons_open", label: "Cotyledons open", sortOrder: 2 },
      { id: DEV_IDS.milestoneFirstTrueLeafId, projectId: DEV_IDS.projectId, key: "first_true_leaf", label: "First true leaf", sortOrder: 3 },
      { id: DEV_IDS.milestoneRootShoulderId, projectId: DEV_IDS.projectId, key: "root_shoulder_visible", label: "Root shoulder visible", sortOrder: 4 },
      { id: DEV_IDS.milestoneHarvestReadyId, projectId: DEV_IDS.projectId, key: "harvest_ready", label: "Harvest ready", sortOrder: 5 },
      { id: DEV_IDS.milestoneHarvestedId, projectId: DEV_IDS.projectId, key: "harvested", label: "Harvested", sortOrder: 6 },
    ],
  });

  await prisma.plantEvent.createMany({
    data: [
      {
        id: DEV_IDS.eventId,
        projectId: DEV_IDS.projectId,
        plantId: DEV_IDS.plantId,
        photoId: DEV_IDS.photoId,
        milestoneId: DEV_IDS.milestoneFirstVisibleId,
        type: "First visible",
        notes: "First visible sprout.",
        timestamp: new Date("2026-07-10T13:30:00.000Z"),
        cropX: 0,
        cropY: 0,
        cropWidth: 1,
        cropHeight: 1,
      },
      {
        id: DEV_IDS.secondEventId,
        projectId: DEV_IDS.projectId,
        plantId: DEV_IDS.plantId,
        photoId: null,
        milestoneId: DEV_IDS.milestoneCotyledonsId,
        type: "Cotyledons open",
        notes: "Recorded from manual inspection.",
        timestamp: new Date("2026-07-10T15:00:00.000Z"),
      },
      {
        id: "dev-visual-event-first-true-leaf",
        projectId: DEV_IDS.projectId,
        plantId: DEV_IDS.plantId,
        photoId: DEV_IDS.secondPhotoId,
        milestoneId: DEV_IDS.milestoneFirstTrueLeafId,
        type: "First true leaf",
        notes: null,
        timestamp: new Date("2026-07-11T14:00:00.000Z"),
      },
    ],
  });

  await prisma.plantHarvestResult.create({
    data: {
      plantId: DEV_IDS.plantId,
      harvestedAt: new Date("2026-07-20T14:00:00.000Z"),
      rootWeightGrams: 18.5,
      rootDiameterMm: 24,
      acceptable: true,
    },
  });

  // Visual history fixtures for DEV_IDS.plantId across all three seeded
  // photos (with a real capture gap between the older photo and the rest),
  // so the scrubber/chronological-order UI has real frames to show.
  // DEV_IDS.secondPlantId intentionally has no crops, for the empty state.
  await prisma.plantPhotoCrop.createMany({
    data: [
      {
        id: DEV_IDS.plantCropOlderId,
        plantId: DEV_IDS.plantId,
        photoId: DEV_IDS.olderPhotoId,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.4,
        cropHeight: 0.4,
        createdMethod: "manual",
      },
      {
        id: DEV_IDS.plantCropId,
        plantId: DEV_IDS.plantId,
        photoId: DEV_IDS.photoId,
        cropX: 0.15,
        cropY: 0.15,
        cropWidth: 0.4,
        cropHeight: 0.4,
        createdMethod: "manual",
      },
      {
        id: DEV_IDS.plantCropSecondId,
        plantId: DEV_IDS.plantId,
        photoId: DEV_IDS.secondPhotoId,
        cropX: 0.74,
        cropY: 0.1,
        cropWidth: 0.16875,
        cropHeight: 0.5333333333333333,
        createdMethod: "propagated",
        sourceCropId: DEV_IDS.plantCropId,
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

export async function cleanupVisualData() {
  const photoDirectory = path.join(process.cwd(), "data", "playwright", "photos");
  await prisma.project.deleteMany({ where: { id: DEV_IDS.projectId } });
  await prisma.cameraProfile.deleteMany({ where: { id: DEV_IDS.profileId } });
  await rm(photoDirectory, { recursive: true, force: true }).catch(() => undefined);
}

export async function mockCameraApis(page: Page) {
  await page.route("**/api/cameras**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cameras: [
          {
            name: "Mock USB Camera",
            device: "/dev/video-test",
            supportsCapture: true,
            stableId: "usb:1234:5678:MOCKSERIAL",
          },
        ],
      }),
    });
  });

  await page.route("**/api/projects/*/camera/controls**", async (route) => {
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

  await page.route("**/api/projects/*/camera/preview**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: Buffer.from(TINY_JPEG_BASE64, "base64"),
    });
  });

  await page.route("**/api/projects/*/camera/formats**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        formats: [
          {
            pixelFormat: "mjpg",
            description: "Motion-JPEG",
            resolutions: [
              { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
              { width: 1280, height: 720, frameRates: ["30.000 fps"] },
            ],
          },
          {
            pixelFormat: "yuyv",
            description: "YUYV 4:2:2",
            resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
          },
        ],
      }),
    });
  });

  await page.route("**/api/service-status**", async (route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        service: {
          health: "running",
          startedAt: now,
          lastHeartbeat: now,
          pid: 12345,
          hostname: "playwright-mock",
          version: null,
          lastError: null,
        },
        activeProjectCount: 0,
        nextScheduledCaptureAt: null,
        projects: [
          {
            projectId: DEV_IDS.projectId,
            name: "Playwright Radish Study",
            captureEnabled: false,
            eligible: false,
            errors: ["Test projects cannot enable scheduled capture."],
            nextCaptureAt: null,
            timeZone: "America/New_York",
            captureWindow: "8:00 PM to 6:00 AM America/New_York time",
            projectLocalTime: now,
            insideCaptureWindow: false,
            isTestProject: true,
            lastSuccessfulCaptureAt: null,
            lastError: null,
          },
        ],
      }),
    });
  });

  await page.route("**/api/projects/*/camera/autofocus**", async (route) => {
    const body = route.request().postDataJSON() as { phase?: string } | null;
    const phase = body?.phase ?? "start";

    if (phase === "start") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          previous: { autofocusValue: false, manualFocusValue: 20 },
          controls: mockControls(),
        }),
      });
      return;
    }

    if (phase === "lock") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ controls: mockControls(), manualFocusValue: 20 }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ controls: mockControls() }),
    });
  });

  await page.route("**/api/projects/*/camera/calibrate**", async (route) => {
    const body = route.request().postDataJSON() as { phase?: string } | null;
    const phase = body?.phase ?? "run";

    if (phase === "lock-auto-modes") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ controls: mockControls() }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          format: "mjpg",
          width: 1920,
          height: 1080,
          steps: [
            { step: "format", applied: true, detail: "mjpg 1920x1080" },
            { step: "reset-defaults", applied: true },
            { step: "auto-white-balance", applied: true },
            { step: "auto-exposure", applied: true, detail: "Aperture Priority Mode" },
            { step: "autofocus-enable", applied: true },
            { step: "focus-lock", applied: true, detail: "manual focus = 20" },
          ],
          focusLocked: true,
          manualFocusValue: 20,
          autoWhiteBalanceAvailable: true,
          autoExposureAvailable: true,
          controls: mockControls(),
        },
        before: TINY_JPEG_BASE64,
        after: TINY_JPEG_BASE64,
      }),
    });
  });

  await page.route("**/api/projects/*/camera/resolution-test**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          { width: 1920, height: 1080, byteSize: 128_000, durationMs: 120, imageBase64: TINY_JPEG_BASE64 },
          { width: 2560, height: 1440, byteSize: 210_000, durationMs: 180, imageBase64: TINY_JPEG_BASE64 },
        ],
      }),
    });
  });

  await page.route("**/api/camera-profiles**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "mock-created-profile",
          name: "Mock Saved Profile",
          cameraDevice: "/dev/video-test",
          cameraName: "Mock USB Camera",
          width: 1920,
          height: 1080,
          inputFormat: "mjpg",
          controlsJson: JSON.stringify({ brightness: 128 }),
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profiles: [
          {
            id: DEV_IDS.profileId,
            name: "Mock Germination Profile",
            cameraDevice: "/dev/video-test",
            cameraName: "Mock USB Camera",
            width: 1920,
            height: 1080,
            inputFormat: "mjpg",
            controlsJson: JSON.stringify({ focus_automatic_continuous: true, brightness: 128 }),
            _count: { projects: 1 },
          },
        ],
      }),
    });
  });
}

function mockControls() {
  return [
    {
      id: "focus_automatic_continuous",
      name: "Focus Automatic Continuous",
      type: "bool",
      value: true,
      defaultValue: true,
      readOnly: false,
      inactive: false,
    },
    {
      id: "focus_absolute",
      name: "Focus Absolute",
      type: "int",
      value: 20,
      minimum: 0,
      maximum: 255,
      step: 5,
      defaultValue: 0,
      readOnly: false,
      // Inactive while continuous autofocus (above) is enabled.
      inactive: true,
    },
    {
      id: "white_balance_automatic",
      name: "White Balance Automatic",
      type: "bool",
      value: true,
      defaultValue: true,
      readOnly: false,
      inactive: false,
    },
    {
      id: "white_balance_temperature",
      name: "White Balance Temperature",
      type: "int",
      value: 4600,
      minimum: 2800,
      maximum: 6500,
      step: 10,
      defaultValue: 4600,
      readOnly: false,
      inactive: true,
    },
    {
      id: "exposure_auto",
      name: "Exposure Auto",
      type: "menu",
      value: 3,
      defaultValue: 3,
      readOnly: false,
      inactive: false,
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
      defaultValue: 128,
      readOnly: false,
      inactive: false,
    },
  ];
}
