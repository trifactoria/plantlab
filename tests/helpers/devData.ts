import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { resolveNodeConfigPath, writeNodeConfig } from "../../src/lib/operations/config";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { ingestPowerState, parsePowerStateReport } from "../../src/lib/operations/powerProtocol";
import { createDesiredSensorConfigRevision, reportAppliedSensorConfig, type DesiredSensorEntry } from "../../src/lib/operations/sensorConfig";
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
  captureSourceId: "dev-visual-capture-source",
  viewportId: "dev-visual-viewport",
  otherProjectId: "dev-visual-shared-project",
};

const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

/**
 * Critical safety boundary (see AGENTS.md / CLAUDE.md and the restored
 * incident where fixture cleanup deleted the live greenhouse-zero node):
 * every mutating fixture helper below calls this first and refuses to run
 * unless it can positively prove it is pointed at an isolated fixture
 * database - never the live coordinator (plantlab) or standalone (xps) one.
 * Exported so the isolation guard itself is directly unit-tested
 * (tests/unit/screenshotIsolation.test.ts).
 */
export function assertFixtureDatabase() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const rootDir = process.env.PLANTLAB_ROOT_DIR ?? "";
  const isVitestIsolated = process.env.VITEST === "true" && /plantlab-test/i.test(databaseUrl);
  const isScreenshotFixture =
    process.env.PLANTLAB_SCREENSHOTS_FIXTURE_ONLY === "1" && /plantlab-test|playwright|fixture|tmp/i.test(`${databaseUrl} ${rootDir}`);
  const looksIsolated =
    (isVitestIsolated || isScreenshotFixture) &&
    !/\/home\/andy\/projects\/plantlab\/prisma\/dev\.db|file:\.\/dev\.db/i.test(databaseUrl);

  if (!looksIsolated) {
    throw new Error(
      "Refusing to seed or clean screenshot fixture data outside an isolated fixture database. " +
        "Set PLANTLAB_SCREENSHOTS_FIXTURE_ONLY=1 and use a test DATABASE_URL/PLANTLAB_ROOT_DIR.",
    );
  }
}

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
  assertFixtureDatabase();
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

  // A shelf camera and a second, non-test project subscribed to one of its
  // viewports - demonstrates the "shared shelf camera" capture-origin card
  // and shelf layout editor without needing real hardware.
  const captureSourceDirectory = path.join(root, "data", "playwright", "capture-source-photos");
  const sharedProjectDirectory = path.join(root, "data", "playwright", "shared-project-photos");
  await mkdir(captureSourceDirectory, { recursive: true });
  await mkdir(sharedProjectDirectory, { recursive: true });

  // seedVisualData() is called more than once within a single test in some
  // specs (to re-seed mid-test) - stay idempotent like the project/profile
  // seeding above, rather than assuming a fresh database.
  await prisma.project.deleteMany({ where: { id: DEV_IDS.otherProjectId } });
  await prisma.captureSource.deleteMany({ where: { id: DEV_IDS.captureSourceId } });

  await prisma.captureSource.create({
    data: {
      id: DEV_IDS.captureSourceId,
      name: "Grow Tent Shelf 1",
      cameraDevice: "/dev/video-test",
      cameraName: "Mock USB Camera",
      cameraStableId: "usb:1234:5678:MOCKSERIAL",
      width: 3840,
      height: 2160,
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
      captureDirectory: captureSourceDirectory,
      active: true,
      photoIntervalMinutes: 30,
      captureStartAt: new Date("2026-07-10T13:00:00.000Z"),
      timeZone: "America/New_York",
      captureWindowEnabled: false,
    },
  });

  await prisma.project.create({
    data: {
      id: DEV_IDS.otherProjectId,
      name: "Shelf Camera Radish Study",
      description: "Subscribes to a viewport of the shared shelf camera.",
      gridWidth: 2,
      gridHeight: 2,
      photoIntervalMinutes: 30,
      captureStartAt: new Date("2026-07-10T13:00:00.000Z"),
      captureEnabled: false,
      timeZone: "America/New_York",
      localPhotoDirectory: sharedProjectDirectory,
    },
  });

  await prisma.projectViewport.create({
    data: {
      id: DEV_IDS.viewportId,
      projectId: DEV_IDS.otherProjectId,
      captureSourceId: DEV_IDS.captureSourceId,
      cropX: 0.05,
      cropY: 0.1,
      cropWidth: 0.25,
      cropHeight: 0.4787,
      effectiveFrom: new Date("2026-07-10T13:00:00.000Z"),
      active: true,
    },
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
  assertFixtureDatabase();
  const photoDirectory = path.join(process.cwd(), "data", "playwright", "photos");
  const captureSourceDirectory = path.join(process.cwd(), "data", "playwright", "capture-source-photos");
  const sharedProjectDirectory = path.join(process.cwd(), "data", "playwright", "shared-project-photos");
  await prisma.project.deleteMany({ where: { id: DEV_IDS.projectId } });
  await prisma.project.deleteMany({ where: { id: DEV_IDS.otherProjectId } });
  await prisma.captureSource.deleteMany({ where: { id: DEV_IDS.captureSourceId } });
  await prisma.cameraProfile.deleteMany({ where: { id: DEV_IDS.profileId } });
  await rm(photoDirectory, { recursive: true, force: true }).catch(() => undefined);
  await rm(captureSourceDirectory, { recursive: true, force: true }).catch(() => undefined);
  await rm(sharedProjectDirectory, { recursive: true, force: true }).catch(() => undefined);
}

// Isolated visual-fixture greenhouse node. Named literally "greenhouse-zero"
// to match the operational routes under test (/nodes/greenhouse-zero/...),
// but this row and everything under it lives only in the isolated Playwright
// test database (see AGENTS.md / CLAUDE.md - automated tests must never
// touch the live xps or plantlab databases). Every ID here is deterministic
// so repeated seedNodeVisualData() calls within a single spec stay idempotent.
export const NODE_VISUAL_NAME = "greenhouse-zero";
/** A project bound to one of NODE_VISUAL_NAME's shelf cameras (remote CaptureSource) with two linked sensors - see the end of seedNodeVisualData(). */
export const NODE_VISUAL_DISTRIBUTED_PROJECT_ID = "greenhouse-zero-distributed-project";

const SENSOR_DEFS = [
  // Outside: coolest and least humid of the four - and deliberately kept
  // free of gaps/failures so its detail page has complete, real-looking history.
  { key: "greenhouse-outside", name: "Outside", gpio: 4, placement: "outside", baseTempC: 17, tempAmplitude: 3, baseHumidity: 42, humidityAmplitude: 6 },
  { key: "greenhouse-bottom", name: "Bottom shelf", gpio: 17, placement: "bottom shelf", baseTempC: 21, tempAmplitude: 2, baseHumidity: 55, humidityAmplitude: 5 },
  // Middle: warm, and carries the intentional short missing-data gap.
  { key: "greenhouse-middle", name: "Middle shelf", gpio: 27, placement: "middle shelf", baseTempC: 24, tempAmplitude: 2, baseHumidity: 58, humidityAmplitude: 5 },
  // Top: most humid, and carries the intermittent-failure diagnostic story.
  { key: "greenhouse-top", name: "Top shelf", gpio: 22, placement: "top shelf", baseTempC: 25, tempAmplitude: 2, baseHumidity: 68, humidityAmplitude: 6 },
] as const;

/** Small deterministic pseudo-random-looking jitter in roughly [-1, 1] - avoids identical repeated values without relying on real randomness (fixtures must stay reproducible). */
function deterministicJitter(seed: number): number {
  return Math.sin(seed * 12.9898) * 0.5 + Math.sin(seed * 3.727) * 0.5;
}

/**
 * Seeds an isolated greenhouse node with a week of distinct, gently-varying
 * per-sensor history (for the metric history charts), a short intentional
 * gap, an intermittent sensor failure, normal fans/lights/water outlets,
 * representative schedules with real execution status, successful and
 * failed power command history, a completed sensor test, and three cameras.
 * See tests/screenshots.spec.ts for the surfaces this backs.
 */
export async function seedNodeVisualData(now: Date = new Date()) {
  assertFixtureDatabase();
  // The coordinator dashboard on the homepage (and its exact node-name link)
  // only renders when the node-local config reports role "coordinator" - see
  // readNodeConfig() in src/app/page.tsx. Without this, the isolated fixture
  // homepage has no greenhouse-zero link and the fixture support-bundle
  // screenshot probe fails (Part 5). resolveNodeConfigPath() writes under
  // PLANTLAB_ROOT_DIR, which assertFixtureDatabase() has already proven is an
  // isolated fixture directory - never the live coordinator's root.
  await writeNodeConfig("coordinator", { nodeName: "fixture-coordinator" });
  // ProjectSensorBinding.node is onDelete: Restrict, so the distributed
  // project fixture (created near the end of this function, below) must be
  // torn down before the node delete on the next line - otherwise a second
  // seedNodeVisualData() call within the same spec (re-seeding mid-test)
  // would fail this delete with a foreign-key violation.
  await prisma.project.deleteMany({ where: { id: NODE_VISUAL_DISTRIBUTED_PROJECT_ID } });
  await prisma.plantLabNode.deleteMany({ where: { name: NODE_VISUAL_NAME } });
  const registered = await registerOrRotateNode(prisma, { name: NODE_VISUAL_NAME, role: "greenhouse-node", rotateCredential: true });
  const nodeId = registered.node.id;

  const STEP_MS = 30 * 60_000;
  const SPAN_MS = 7 * 24 * 60 * 60_000;
  const start = new Date(now.getTime() - SPAN_MS);
  const gapStart = new Date(now.getTime() - 10 * 60 * 60_000);
  const gapEnd = new Date(now.getTime() - 8 * 60 * 60_000);
  const topReadingCutoff = new Date(now.getTime() - 3 * 60 * 60_000);

  for (const def of SENSOR_DEFS) {
    const sensor = await prisma.nodeSensor.upsert({
      where: { nodeId_key: { nodeId, key: def.key } },
      create: { nodeId, key: def.key, name: def.name, type: "dht22", gpio: def.gpio, placement: def.placement, enabled: true, firstSeenAt: start, lastSeenAt: now },
      update: { name: def.name, type: "dht22", gpio: def.gpio, placement: def.placement, enabled: true, lastSeenAt: now },
    });

    const readings: { sensorId: string; nodeId: string; eventId: string; capturedAt: Date; temperatureC: number; humidityPct: number }[] = [];
    const readingEnd = def.key === "greenhouse-top" ? topReadingCutoff.getTime() : now.getTime();
    let index = 0;
    let lastReading: { at: Date; temperatureC: number; humidityPct: number } | null = null;

    for (let t = start.getTime(); t <= readingEnd; t += STEP_MS) {
      const at = new Date(t);
      if (def.key === "greenhouse-middle" && at >= gapStart && at <= gapEnd) {
        index += 1;
        continue;
      }
      const dayPhase = (t / (24 * 60 * 60_000)) * 2 * Math.PI;
      const temperatureC = Math.round((def.baseTempC + Math.sin(dayPhase) * def.tempAmplitude + deterministicJitter(index) * 0.4) * 10) / 10;
      const humidityPct = Math.max(0, Math.min(100, Math.round((def.baseHumidity + Math.cos(dayPhase) * def.humidityAmplitude + deterministicJitter(index + 1000) * 1.2) * 10) / 10));
      readings.push({ sensorId: sensor.id, nodeId, eventId: `${def.key}-${index}`, capturedAt: at, temperatureC, humidityPct });
      lastReading = { at, temperatureC, humidityPct };
      index += 1;
    }
    if (readings.length > 0) {
      await prisma.sensorReading.createMany({ data: readings });
    }

    if (def.key === "greenhouse-top") {
      const diagnosticTimes = [165, 135, 105, 75, 45, 15].map((minutesAgo) => new Date(now.getTime() - minutesAgo * 60_000));
      const outcomes: Array<{ classification: "accepted" | "failed"; code: string | null; message: string | null }> = [
        { classification: "accepted", code: null, message: null },
        { classification: "failed", code: "sensor-no-response", message: "No DHT22 response pulses were received." },
        { classification: "accepted", code: null, message: null },
        { classification: "failed", code: "sensor-no-response", message: "No DHT22 response pulses were received." },
        { classification: "accepted", code: null, message: null },
        { classification: "failed", code: "sensor-no-response", message: "No DHT22 response pulses were received." },
      ];
      let lastAcceptedAt: Date | null = lastReading?.at ?? null;
      for (let i = 0; i < diagnosticTimes.length; i += 1) {
        const at = diagnosticTimes[i];
        const outcome = outcomes[i];
        if (outcome.classification === "accepted") {
          const temperatureC = Math.round((def.baseTempC + deterministicJitter(2000 + i) * 0.5) * 10) / 10;
          const humidityPct = Math.round((def.baseHumidity + deterministicJitter(3000 + i) * 1.5) * 10) / 10;
          await prisma.sensorReading.create({ data: { sensorId: sensor.id, nodeId, eventId: `${def.key}-diag-${i}`, capturedAt: at, temperatureC, humidityPct } });
          lastAcceptedAt = at;
        } else {
          await prisma.sensorDiagnostic.create({
            data: { sensorId: sensor.id, nodeId, eventId: `${def.key}-diag-${i}`, capturedAt: at, classification: outcome.classification, code: outcome.code, message: outcome.message, gpio: def.gpio },
          });
        }
      }
      await prisma.nodeSensor.update({
        where: { id: sensor.id },
        data: {
          latestClassification: "failed",
          latestTemperatureC: null,
          latestHumidityPct: null,
          lastAttemptAt: diagnosticTimes[diagnosticTimes.length - 1],
          lastAcceptedAt,
          consecutiveFailures: 1,
          consecutiveRejects: 0,
          lastDiagnosticCode: "sensor-no-response",
          lastDiagnosticMessage: "No DHT22 response pulses were received.",
        },
      });
    } else if (lastReading) {
      await prisma.nodeSensor.update({
        where: { id: sensor.id },
        data: {
          latestClassification: "accepted",
          latestTemperatureC: lastReading.temperatureC,
          latestHumidityPct: lastReading.humidityPct,
          lastAttemptAt: lastReading.at,
          lastAcceptedAt: lastReading.at,
          consecutiveFailures: 0,
          consecutiveRejects: 0,
          lastDiagnosticCode: null,
          lastDiagnosticMessage: null,
        },
      });
    }
  }

  // A retired/historical sensor (greenhouse-ambient) with real readings, so
  // the "Retired / historical" section and "history still reachable" state
  // are exercised - it must stay out of active charts.
  const ambient = await prisma.nodeSensor.create({
    data: {
      nodeId,
      key: "greenhouse-ambient",
      name: "Ambient (retired)",
      type: "dht22",
      gpio: 5,
      placement: "old ambient probe",
      enabled: false,
      configuredActive: false,
      retiredAt: new Date(now.getTime() - 5 * 24 * 60 * 60_000),
      firstSeenAt: new Date(now.getTime() - 20 * 24 * 60 * 60_000),
      lastSeenAt: new Date(now.getTime() - 5 * 24 * 60 * 60_000),
      lastAttemptAt: new Date(now.getTime() - 5 * 24 * 60 * 60_000),
      lastAcceptedAt: new Date(now.getTime() - 5 * 24 * 60 * 60_000),
      latestClassification: "accepted",
      latestTemperatureC: 20.4,
      latestHumidityPct: 51,
    },
  });
  await prisma.sensorReading.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({
      sensorId: ambient.id,
      nodeId,
      eventId: `greenhouse-ambient-${i}`,
      capturedAt: new Date(now.getTime() - (6 * 24 + i) * 60 * 60_000),
      temperatureC: 20 + deterministicJitter(4000 + i),
      humidityPct: 50 + deterministicJitter(5000 + i) * 2,
    })),
  });

  // Establish an applied desired/applied sensor config revision (1/1) so the
  // desired/applied/observed UI shows a real "Applied revision #1" state
  // rather than the legacy compatibility heuristic. The four shelf sensors
  // are active; ambient is retired.
  const configEntries: DesiredSensorEntry[] = [
    ...SENSOR_DEFS.map((def) => ({ key: def.key, name: def.name, type: "dht22", gpio: def.gpio, placement: def.placement, enabled: true, retired: false })),
    { key: "greenhouse-ambient", name: "Ambient (retired)", type: "dht22", gpio: 5, placement: "old ambient probe", enabled: false, retired: true },
  ];
  await createDesiredSensorConfigRevision(prisma, NODE_VISUAL_NAME, configEntries, { requestedBy: "fixture" });
  await reportAppliedSensorConfig(prisma, nodeId, { revision: 1, status: "applied", entries: configEntries });
  // Re-assert the seeded observed status the config sync doesn't touch, so
  // "observed failure does not imply configuration rejection" is visible on
  // greenhouse-top (applied #1, but observed failing).
  await prisma.nodeSensor.update({
    where: { nodeId_key: { nodeId, key: "greenhouse-top" } },
    data: { latestClassification: "failed", latestTemperatureC: null, latestHumidityPct: null, lastDiagnosticCode: "sensor-no-response", lastDiagnosticMessage: "No DHT22 response pulses were received." },
  });

  // Fans, lights, and water are all ordinary "normal" outlets - Water has no
  // special safety casing (see src/lib/outletBehavior.ts).
  await ingestPowerState(
    prisma,
    nodeId,
    parsePowerStateReport(
      {
        outlets: [
          {
            key: "fans",
            name: "Fans",
            provider: "kasa",
            providerAlias: "greenhouse-fans",
            behavior: "normal",
            safetyClass: "switch",
            actualState: true,
            available: true,
            stateObservedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
          },
          {
            key: "lights",
            name: "Lights",
            provider: "kasa",
            providerAlias: "greenhouse-lights",
            behavior: "normal",
            safetyClass: "switch",
            actualState: false,
            available: true,
            stateObservedAt: new Date(now.getTime() - 12 * 60 * 60_000).toISOString(),
          },
          {
            key: "water",
            name: "Water",
            provider: "kasa",
            providerAlias: "greenhouse-water",
            behavior: "normal",
            safetyClass: "switch",
            actualState: false,
            available: true,
            stateObservedAt: new Date(now.getTime() - 20 * 60 * 60_000).toISOString(),
          },
        ],
      },
      now,
    ),
  );

  // Successful and failed manual command history, for the node timeline.
  await prisma.powerCommand.create({
    data: {
      nodeId,
      outletKey: "fans",
      action: "on",
      status: "succeeded",
      requestedAt: new Date(now.getTime() - 5 * 60_000),
      claimedAt: new Date(now.getTime() - 5 * 60_000 + 500),
      completedAt: new Date(now.getTime() - 5 * 60_000 + 1200),
      expiresAt: new Date(now.getTime() + 4 * 60_000),
      actualState: true,
      stateObservedAt: new Date(now.getTime() - 5 * 60_000 + 1200),
      requestedBy: "manual",
    },
  });
  await prisma.powerCommand.create({
    data: {
      nodeId,
      outletKey: "lights",
      action: "on",
      status: "failed",
      requestedAt: new Date(now.getTime() - 3 * 60 * 60_000),
      claimedAt: new Date(now.getTime() - 3 * 60 * 60_000 + 800),
      completedAt: new Date(now.getTime() - 3 * 60 * 60_000 + 4000),
      expiresAt: new Date(now.getTime() - 3 * 60 * 60_000 + 5 * 60_000),
      errorCode: "kasa-connect-failed",
      errorMessage: "Could not reach the Kasa device on the local network.",
      requestedBy: "manual",
    },
  });

  // A schedule with real, observed execution status (not just "Never run").
  const scheduleFiredAt = new Date(now.getTime() - 2 * 60 * 60_000);
  const scheduleCommand = await prisma.powerCommand.create({
    data: {
      nodeId,
      outletKey: "lights",
      action: "on",
      status: "succeeded",
      requestedAt: scheduleFiredAt,
      claimedAt: new Date(scheduleFiredAt.getTime() + 500),
      completedAt: new Date(scheduleFiredAt.getTime() + 1500),
      expiresAt: new Date(scheduleFiredAt.getTime() + 5 * 60_000),
      actualState: true,
      stateObservedAt: new Date(scheduleFiredAt.getTime() + 1500),
      requestedBy: "schedule:seed-morning-lights",
      idempotencyKey: "schedule:seed-morning-lights:fixture",
    },
  });
  const todayKey = now.toISOString().slice(0, 10);
  await prisma.powerSchedule.create({
    data: {
      nodeId,
      outletKey: "lights",
      action: "on",
      timeOfDay: "07:00",
      daysOfWeek: "0,1,2,3,4,5,6",
      timeZone: "America/New_York",
      label: "Morning lights",
      enabled: true,
      lastRunDateKey: todayKey,
      lastRunAt: scheduleFiredAt,
      lastRunStatus: "queued",
      lastCommandId: scheduleCommand.id,
    },
  });
  await prisma.powerSchedule.create({
    data: { nodeId, outletKey: "lights", action: "off", timeOfDay: "19:00", daysOfWeek: "0,1,2,3,4,5,6", timeZone: "America/New_York", label: "Evening lights off", enabled: true },
  });
  await prisma.powerSchedule.create({
    data: { nodeId, outletKey: "water", action: "on", timeOfDay: "08:00", daysOfWeek: "1,2,3,4,5", timeZone: "America/New_York", label: "Weekday watering", enabled: true },
  });

  // One completed sensor test result (deterministic - a "running" state
  // isn't reproducible for a static screenshot without a live edge agent).
  await prisma.sensorTestCommand.create({
    data: {
      nodeId,
      sensorKey: "greenhouse-outside",
      status: "succeeded",
      attemptsRequested: 3,
      intervalSeconds: 2,
      requestedAt: new Date(now.getTime() - 30 * 60_000),
      claimedAt: new Date(now.getTime() - 30 * 60_000 + 500),
      startedAt: new Date(now.getTime() - 30 * 60_000 + 600),
      completedAt: new Date(now.getTime() - 30 * 60_000 + 7000),
      expiresAt: new Date(now.getTime() - 30 * 60_000 + 5 * 60_000),
      attemptsCompleted: 3,
      acceptedCount: 3,
      failedCount: 0,
      finalPass: true,
      effectiveDriver: "pigpio",
      configuredGpio: 4,
      attemptsJson: JSON.stringify([
        { attempt: 1, classification: "accepted", code: null, message: null, temperatureC: 18.2, humidityPct: 43.1 },
        { attempt: 2, classification: "accepted", code: null, message: null, temperatureC: 18.3, humidityPct: 43.0 },
        { attempt: 3, classification: "accepted", code: null, message: null, temperatureC: 18.1, humidityPct: 43.4 },
      ]),
    },
  });

  // Cameras: three physically-identical USB webcams (same vendor/product/
  // serial, matching the live greenhouse-zero situation) distinguished only
  // by physical/USB path. Two are active and assigned; one went unavailable
  // after a USB reconnect and has reattach candidates (one ambiguous).
  const SHARED = { vendorId: "32e6", productId: "9221", serial: "202601081445001" };
  const CAM_FORMATS = JSON.stringify([{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }, { width: 1280, height: 720, frameRates: ["30 fps"] }] }]);
  const evidence = (physicalPath: string) => JSON.stringify({ serial: SHARED.serial, vendorId: SHARED.vendorId, productId: SHARED.productId, physicalPath });

  async function makeAssignedCamera(opts: { stableId: string; name: string; devicePath: string; physicalPath: string; usbPort: string; rotation: number }) {
    const camera = await prisma.nodeCamera.create({
      data: {
        nodeId,
        stableId: opts.stableId,
        devicePath: opts.devicePath,
        name: opts.name,
        ...SHARED,
        physicalPath: opts.physicalPath,
        usbPath: opts.physicalPath,
        usbPort: opts.usbPort,
        formatsJson: CAM_FORMATS,
        identityEvidenceJson: evidence(opts.physicalPath),
        available: true,
        enabled: true,
        lastSeenAt: now,
      },
    });
    const source = await prisma.captureSource.create({
      data: {
        name: `${opts.name} source`,
        cameraDevice: opts.devicePath,
        cameraName: opts.name,
        cameraStableId: opts.stableId,
        width: 1920,
        height: 1080,
        rotation: opts.rotation,
        captureDirectory: path.join(process.cwd(), "data", "playwright", `cam-${opts.usbPort}`),
        photoIntervalMinutes: 60,
        active: true,
      },
    });
    await prisma.nodeCamera.update({ where: { id: camera.id }, data: { captureSourceId: source.id } });
    await prisma.nodeCameraAssignment.create({
      data: { nodeId, nodeCameraId: camera.id, captureSourceId: source.id, name: `${opts.name} 1080p`, width: 1920, height: 1080, inputFormat: "mjpeg", active: true },
    });
    await prisma.nodeCameraEndpoint.create({
      data: { nodeId, nodeCameraId: camera.id, stableId: opts.stableId, devicePath: opts.devicePath, name: opts.name, ...SHARED, physicalPath: opts.physicalPath, usbPath: opts.physicalPath, usbPort: opts.usbPort, formatsJson: CAM_FORMATS, available: true, confidence: "reported-stable-id", evidenceJson: evidence(opts.physicalPath) },
    });
    return { camera, source };
  }

  const wideCamera = await makeAssignedCamera({ stableId: "usb:32e6:9221:202601081445001:path:usb-0:1.1", name: "Greenhouse Wide", devicePath: "/dev/video0", physicalPath: "platform-fd500000.pcie-usb-0:1.1", usbPort: "1.1", rotation: 0 });
  await makeAssignedCamera({ stableId: "usb:32e6:9221:202601081445001:path:usb-0:1.2", name: "Greenhouse Top Shelf", devicePath: "/dev/video2", physicalPath: "platform-fd500000.pcie-usb-0:1.2", usbPort: "1.2", rotation: 90 });

  // The unavailable camera - it was at usb port 1.3 and went missing after a
  // reconnect. Keep its active assignment so reattach has something to fix.
  const doorPhysical = "platform-fd500000.pcie-usb-0:1.3";
  const door = await prisma.nodeCamera.create({
    data: {
      nodeId,
      stableId: "usb:32e6:9221:202601081445001:path:usb-0:1.3",
      devicePath: "/dev/video4",
      name: "Greenhouse Door",
      ...SHARED,
      physicalPath: doorPhysical,
      usbPath: doorPhysical,
      usbPort: "1.3",
      formatsJson: CAM_FORMATS,
      identityEvidenceJson: evidence(doorPhysical),
      available: false,
      enabled: true,
      lastSeenAt: new Date(now.getTime() - 6 * 60 * 60_000),
    },
  });
  const doorSource = await prisma.captureSource.create({
    data: { name: "Greenhouse Door source", cameraDevice: "/dev/video4", cameraName: "Greenhouse Door", cameraStableId: door.stableId, width: 1920, height: 1080, rotation: 0, captureDirectory: path.join(process.cwd(), "data", "playwright", "cam-door"), photoIntervalMinutes: 60, active: true },
  });
  await prisma.nodeCamera.update({ where: { id: door.id }, data: { captureSourceId: doorSource.id } });
  await prisma.nodeCameraAssignment.create({
    data: { nodeId, nodeCameraId: door.id, captureSourceId: doorSource.id, name: "Greenhouse Door 1080p", width: 1920, height: 1080, inputFormat: "mjpeg", active: true },
  });
  // Its old (now unavailable) endpoint...
  await prisma.nodeCameraEndpoint.create({
    data: { nodeId, nodeCameraId: door.id, stableId: door.stableId, devicePath: "/dev/video4", name: "Greenhouse Door", ...SHARED, physicalPath: doorPhysical, usbPath: doorPhysical, usbPort: "1.3", formatsJson: CAM_FORMATS, available: false, unavailableAt: new Date(now.getTime() - 6 * 60 * 60_000), confidence: "reported-stable-id", evidenceJson: evidence(doorPhysical) },
  });
  // ...and two available discovered endpoints it could reattach to. The first
  // shares the serial AND is on the moved-but-plausible 1.3.3 path; the second
  // shares only the serial - so the pair is intentionally ambiguous.
  await prisma.nodeCameraEndpoint.create({
    data: { nodeId, nodeCameraId: null, stableId: "usb:32e6:9221:202601081445001:path:usb-0:1.3.3", devicePath: "/dev/video6", name: "webcam 1080P", ...SHARED, physicalPath: "platform-fd500000.pcie-usb-0:1.3.3", usbPath: "platform-fd500000.pcie-usb-0:1.3.3", usbPort: "1.3.3", formatsJson: CAM_FORMATS, available: true, confidence: "serial-vendor-product", evidenceJson: evidence("platform-fd500000.pcie-usb-0:1.3.3") },
  });
  await prisma.nodeCameraEndpoint.create({
    data: { nodeId, nodeCameraId: null, stableId: "usb:32e6:9221:202601081445001:path:usb-0:1.4", devicePath: "/dev/video8", name: "webcam 1080P", ...SHARED, physicalPath: "platform-fd500000.pcie-usb-0:1.4", usbPath: "platform-fd500000.pcie-usb-0:1.4", usbPort: "1.4", formatsJson: CAM_FORMATS, available: true, confidence: "serial-vendor-product", evidenceJson: evidence("platform-fd500000.pcie-usb-0:1.4") },
  });

  // A distributed project bound to the "Greenhouse Wide" shelf camera
  // (a remote CaptureSource, not a raw /dev/video* path) with two linked
  // applied/active sensors and one photo timed to land right on the
  // sensors' last reading - backs the Project UI Phase 1 screenshots and
  // e2e specs (CaptureSource picker, linked sensors, environment charts,
  // and the photo environment card's "matched within" case).
  const distributedProjectDirectory = path.join(process.cwd(), "data", "playwright", "distributed-project-photos");
  await mkdir(distributedProjectDirectory, { recursive: true });
  await prisma.project.deleteMany({ where: { id: NODE_VISUAL_DISTRIBUTED_PROJECT_ID } });
  const distributedProject = await prisma.project.create({
    data: {
      id: NODE_VISUAL_DISTRIBUTED_PROJECT_ID,
      name: "Greenhouse Wide Shelf Study",
      description: "Distributed project bound to a remote node camera and linked environmental sensors.",
      gridWidth: 2,
      gridHeight: 2,
      photoIntervalMinutes: 60,
      captureStartAt: new Date(now.getTime() - 60 * 60_000),
      captureEnabled: false,
      timeZone: "America/New_York",
      localPhotoDirectory: distributedProjectDirectory,
    },
  });
  await prisma.projectViewport.create({
    data: {
      projectId: distributedProject.id,
      captureSourceId: wideCamera.source.id,
      cropX: 0,
      cropY: 0,
      cropWidth: 1,
      cropHeight: 1,
      effectiveFrom: new Date(now.getTime() - 60 * 60_000),
      active: true,
    },
  });
  const outsideSensor = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId, key: "greenhouse-outside" } } });
  const middleSensor = await prisma.nodeSensor.findUniqueOrThrow({ where: { nodeId_key: { nodeId, key: "greenhouse-middle" } } });
  await prisma.projectSensorBinding.create({
    data: { projectId: distributedProject.id, nodeId, sensorId: outsideSensor.id, role: "outside-reference" },
  });
  await prisma.projectSensorBinding.create({
    data: { projectId: distributedProject.id, nodeId, sensorId: middleSensor.id, role: "middle-shelf", label: "Middle Shelf" },
  });
  const distributedPhotoPath = path.join(distributedProjectDirectory, "greenhouse-wide-latest.jpg");
  await writeFixturePhoto(distributedPhotoPath);
  await prisma.photo.create({
    data: {
      id: `${NODE_VISUAL_DISTRIBUTED_PROJECT_ID}-photo`,
      projectId: distributedProject.id,
      filename: "greenhouse-wide-latest.jpg",
      path: distributedPhotoPath,
      // The outside/middle sensor series' last reading lands exactly at
      // `now` (7-day span / 30-minute step divides evenly) - a few seconds
      // off keeps the photo environment card's nearest-match distinct from
      // a literal zero without missing the match window.
      timestamp: new Date(now.getTime() - 8_000),
      notes: null,
    },
  });

  return { nodeName: NODE_VISUAL_NAME, nodeId, distributedProjectId: distributedProject.id };
}

/** Cascades to every row created by seedNodeVisualData() via onDelete: Cascade on PlantLabNode's relations. */
export async function cleanupNodeVisualData() {
  assertFixtureDatabase();
  // ProjectSensorBinding.node is onDelete: Restrict (a project should never
  // be silently orphaned by deleting the node it monitors) - the
  // distributed project fixture must be deleted before the node, or the
  // node delete below fails its foreign-key check.
  const distributedProjectDirectory = path.join(process.cwd(), "data", "playwright", "distributed-project-photos");
  await prisma.project.deleteMany({ where: { id: NODE_VISUAL_DISTRIBUTED_PROJECT_ID } });
  await rm(distributedProjectDirectory, { recursive: true, force: true }).catch(() => undefined);
  // CaptureSource has no nodeId column (NodeCamera -> CaptureSource is the
  // only link, onDelete: SetNull), so deleting the node alone leaves this
  // fixture's per-camera CaptureSource rows ("Greenhouse Wide source" etc.)
  // orphaned in the database instead of cascading away. Across many repeated
  // seed/cleanup cycles against the same fixture database (e.g. re-running
  // specs locally) those orphans accumulate, and a lookup by name (as e2e
  // specs do, since CaptureSource ids are freshly generated every seed) can
  // resolve to a stale orphan instead of the currently-seeded one. Delete
  // them explicitly, before the node itself, while they can still be found
  // via NodeCamera.captureSourceId.
  const node = await prisma.plantLabNode.findUnique({ where: { name: NODE_VISUAL_NAME }, include: { cameras: { select: { captureSourceId: true } } } });
  const captureSourceIds = (node?.cameras ?? []).map((camera) => camera.captureSourceId).filter((id): id is string => id !== null);
  if (captureSourceIds.length > 0) {
    await prisma.captureSource.deleteMany({ where: { id: { in: captureSourceIds } } });
  }
  await prisma.plantLabNode.deleteMany({ where: { name: NODE_VISUAL_NAME } });
  // Remove the isolated coordinator config written by seedNodeVisualData so a
  // reused fixture directory doesn't leak coordinator role into later runs.
  await rm(resolveNodeConfigPath(), { force: true }).catch(() => undefined);
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
              { width: 3840, height: 2160, frameRates: ["15.000 fps"] },
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

  await page.route("**/api/projects/*/camera/verify-capture**", async (route) => {
    const body = route.request().postDataJSON() as { width?: number; height?: number } | null;
    const width = body?.width ?? 1920;
    const height = body?.height ?? 1080;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestedWidth: width,
        requestedHeight: height,
        actualWidth: width,
        actualHeight: height,
        matched: true,
        byteSize: width === 3840 ? 1_450_000 : 420_000,
        imageBase64: TINY_JPEG_BASE64,
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

  await page.route("**/api/capture-sources/*/formats**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        formats: [
          {
            pixelFormat: "mjpeg",
            description: "Motion-JPEG",
            resolutions: [
              { width: 3840, height: 2160, frameRates: ["15.000 fps"] },
              { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
            ],
          },
          {
            pixelFormat: "yuyv422",
            description: "YUYV 4:2:2",
            resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
          },
        ],
      }),
    });
  });

  await page.route("**/api/capture-sources/*/test-frame**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sourceCapture: { id: "mock-source-capture" },
        workingWidth: 3840,
        workingHeight: 2160,
        imageBase64: TINY_JPEG_BASE64,
      }),
    });
  });

  await page.route("**/api/capture-sources/*/test-capture**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sourceCapture: { id: "mock-source-capture" },
        fanOut: {
          sourceCaptureId: "mock-source-capture",
          sourceWidth: 3840,
          sourceHeight: 2160,
          projectResults: [
            {
              projectId: DEV_IDS.otherProjectId,
              projectName: "Shelf Camera Radish Study",
              viewportId: DEV_IDS.viewportId,
              status: "success",
              photoId: "mock-derived-photo",
              derivedWidth: 960,
              derivedHeight: 1036,
            },
          ],
        },
      }),
    });
  });

  await page.route("**/api/capture-sources/*/viewports**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "mock-created-viewport",
          projectId: DEV_IDS.otherProjectId,
          project: { id: DEV_IDS.otherProjectId, name: "Shelf Camera Radish Study" },
          cropX: 0.35,
          cropY: 0.1,
          cropWidth: 0.25,
          cropHeight: 0.4787,
          active: true,
          effectiveFrom: new Date().toISOString(),
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        viewports: [
          {
            id: DEV_IDS.viewportId,
            projectId: DEV_IDS.otherProjectId,
            project: { id: DEV_IDS.otherProjectId, name: "Shelf Camera Radish Study" },
            cropX: 0.05,
            cropY: 0.1,
            cropWidth: 0.25,
            cropHeight: 0.4787,
            active: true,
            effectiveFrom: "2026-07-10T13:00:00.000Z",
          },
        ],
        overlappingViewportIds: [],
      }),
    });
  });

  await page.route("**/api/capture-sources/*", async (route) => {
    const method = route.request().method();
    if (method === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: DEV_IDS.captureSourceId }),
      });
      return;
    }

    await route.fallback();
  });

  await page.route("**/api/viewports/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: DEV_IDS.viewportId, active: false }),
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
