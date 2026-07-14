import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { cleanupNodeVisualData, cleanupVisualData, disconnectPrisma, mockCameraApis, NODE_VISUAL_NAME, seedNodeVisualData, seedVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

// Full-suite viewports run every project surface below; "mobile" is scoped
// to the newer node/operational surfaces only (see the task note this
// mirrors: the older project screenshot suite stays desktop/laptop only,
// one mobile viewport was added specifically for the new surfaces).
const viewports = [
  { name: "desktop", width: 1440, height: 1000, scope: "full" as const },
  { name: "laptop", width: 1024, height: 768, scope: "full" as const },
  { name: "mobile", width: 390, height: 844, scope: "node-only" as const },
];

test.afterEach(async () => {
  await cleanupVisualData();
  await cleanupNodeVisualData();
});

test.afterAll(async () => {
  await disconnectPrisma();
});

async function capture(page: Page, name: string) {
  const outputDir = path.join(process.cwd(), "artifacts", "screenshots");
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage: true,
  });
}

/**
 * Coverage manifest for the node/operational surfaces below - keep this in
 * sync with captureNodeSurfaces() so it stays obvious at a glance which
 * routes have screenshot coverage without reading the whole capture
 * sequence. See AGENTS.md / CLAUDE.md: fixture data here is isolated to the
 * Playwright test database and must never touch the live xps or plantlab
 * databases - see seedNodeVisualData() in tests/helpers/devData.ts.
 */
const nodeSurfaces = [
  `/nodes/${NODE_VISUAL_NAME}`,
  `/nodes/${NODE_VISUAL_NAME}/sensors`,
  `/nodes/${NODE_VISUAL_NAME}/sensors/greenhouse-outside`,
  `/nodes/${NODE_VISUAL_NAME}/sensors/greenhouse-top`,
  `/nodes/${NODE_VISUAL_NAME}/cameras`,
  `/nodes/${NODE_VISUAL_NAME}/power`,
  `/nodes/${NODE_VISUAL_NAME}/activity`,
] as const;

const projectSurfaces = [
  "/",
  "/projects/:projectId",
  "/projects/:projectId/settings",
  "/projects/:projectId/camera",
  "/capture-sources",
  "/capture-sources/:sourceId",
  "/projects/:projectId/timeline",
  "/projects/:projectId/comparison",
  "/photos/:photoId",
  "/plants/:plantId",
  "/projects/:projectId/gallery/:month",
  "/projects/:projectId/gallery/:month/:day",
] as const;

/** Home page plus every /nodes/[nodeName]/... operational surface: outlet controls (including Water as an ordinary outlet), charts, sensor/camera/power/activity subsystem pages. See nodeSurfaces above. */
async function captureNodeSurfaces(page: Page, prefix: string) {
  await mockCameraApis(page);
  await seedNodeVisualData();

  await goto(page, "/");
  await expect(page.getByRole("link", { name: NODE_VISUAL_NAME, exact: true })).toBeVisible();
  await capture(page, `${prefix}-home-with-node`);

  // Node overview: three normal outlet cards (fans/lights/water), temperature
  // and humidity charts across sensors at the default 24h range, and the
  // degraded-sensor summary (Top shelf's intermittent failure). Wait for
  // real content signals rather than fixed delays - outlets and sensor
  // status are async client fetches.
  await goto(page, `/nodes/${NODE_VISUAL_NAME}`);
  await expect(page.getByRole("button", { name: "Turn Fans on" })).toBeVisible();
  await expect(page.getByText("Fresh", { exact: true }).first()).toBeVisible();
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
  await page.waitForTimeout(300);
  await capture(page, `${prefix}-node-overview-24h`);

  const chartRangeGroup = page.getByRole("group", { name: "Chart range" });
  await chartRangeGroup.getByRole("button", { name: "7d" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  await capture(page, `${prefix}-node-overview-7d`);

  // Sensors subsystem list.
  await goto(page, `/nodes/${NODE_VISUAL_NAME}/sensors`);
  await expect(page.getByRole("link", { name: "Outside" })).toBeVisible();
  await capture(page, `${prefix}-node-sensors-list`);

  // Healthy sensor detail with complete real-looking history and a
  // completed sensor-test result (Outside was seeded free of gaps/failures).
  await goto(page, `/nodes/${NODE_VISUAL_NAME}/sensors/greenhouse-outside`);
  await expect(page.getByText("Succeeded", { exact: true }).first()).toBeVisible();
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
  await page.waitForTimeout(300);
  await capture(page, `${prefix}-sensor-detail-healthy`);

  // Failed/intermittent sensor detail (Top shelf's seeded diagnostic story).
  await goto(page, `/nodes/${NODE_VISUAL_NAME}/sensors/greenhouse-top`);
  await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(300);
  await capture(page, `${prefix}-sensor-detail-intermittent`);

  // Cameras subsystem page - three cameras, one unavailable.
  await goto(page, `/nodes/${NODE_VISUAL_NAME}/cameras`);
  await expect(page.getByText("Greenhouse Wide")).toBeVisible();
  await capture(page, `${prefix}-node-cameras`);

  // Power subsystem page - normal outlet controls (Water included) and the
  // Daily timers table, which also shows a real "Succeeded" schedule
  // execution status for the seeded Morning lights schedule.
  await goto(page, `/nodes/${NODE_VISUAL_NAME}/power`);
  await expect(page.getByRole("button", { name: "Turn Water on" })).toBeVisible();
  await expect(page.getByText("Succeeded", { exact: true }).first()).toBeVisible();
  await capture(page, `${prefix}-node-power-outlets-and-schedule-status`);

  // Timer form with Water available as an ordinary schedulable outlet.
  await page.locator('form:has(h4:has-text("Add a timer")) select').first().selectOption("water");
  await capture(page, `${prefix}-node-power-timer-form-water`);

  // Node activity timeline (successful and failed power commands, the fired schedule).
  await goto(page, `/nodes/${NODE_VISUAL_NAME}/activity`);
  await expect(page.getByText(/fans ON succeeded/i)).toBeVisible();
  await capture(page, `${prefix}-node-activity-timeline`);
}

for (const viewport of viewports) {
  test(`screenshots ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const prefix = viewport.name;

    if (viewport.scope === "node-only") {
      await captureNodeSurfaces(page, prefix);
      return;
    }

    await mockCameraApis(page);
    const ids = await seedVisualData();

    await goto(page, "/");
    await capture(page, `${prefix}-home`);
    await capture(page, `${prefix}-project-create-schedule-timezone`);

    await goto(page, `/projects/${ids.projectId}`);
    await capture(page, `${prefix}-project-dashboard`);
    await capture(page, `${prefix}-project-outside-capture-window`);
    await capture(page, `${prefix}-test-project-badge`);
    await capture(page, `${prefix}-manual-photo-upload`);

    await page.getByTestId("grid-cell-2-2").click();
    await capture(page, `${prefix}-create-plant-dialog`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/projects/${ids.projectId}/settings`);
    await capture(page, `${prefix}-project-settings`);
    await capture(page, `${prefix}-project-settings-capture-hours`);
    await capture(page, `${prefix}-schedule-summary-next-five`);

    await page.getByRole("button", { name: "Delete Project" }).click();
    await capture(page, `${prefix}-delete-confirmation`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/projects/${ids.projectId}/camera`);
    await capture(page, `${prefix}-camera-setup-idle`);

    await page.getByLabel("Resolution").selectOption({ label: "3840 x 2160 (15.000 fps)" });
    await capture(page, `${prefix}-camera-4k-mode-selected`);

    await page.getByRole("button", { name: "Verify Full-Resolution Capture" }).click();
    await page.getByTestId("verify-capture-result").waitFor();
    await capture(page, `${prefix}-camera-verify-capture-result`);

    // Shelf camera flow: a shared physical source that several projects
    // can each claim a rectangular viewport of, instead of direct capture.
    await goto(page, "/capture-sources");
    await capture(page, `${prefix}-capture-sources-list`);

    await goto(page, `/capture-sources/${ids.captureSourceId}`);
    await page.getByTestId("raw-resolution-select").selectOption({ label: "MJPEG - 3840x2160 - 15.000 fps" });
    await page.getByTestId("rotation-select").selectOption("90");
    await capture(page, `${prefix}-shelf-camera-4k-rotation-preview`);

    await page.getByRole("button", { name: "Capture Test Frame" }).click();
    await page.getByTestId("shelf-layout-stage").waitFor();
    await capture(page, `${prefix}-shelf-layout-with-regions`);

    await page.getByRole("button", { name: "Trigger Test Capture" }).click();
    await page.getByTestId("test-capture-results").waitFor();
    await capture(page, `${prefix}-shelf-test-fanout-result`);
    // triggerTestCapture() calls router.refresh() after resolving; let that
    // in-flight RSC refetch settle before navigating away so it can't race
    // with the next page's own navigation/hydration.
    await page.waitForLoadState("networkidle");

    await goto(page, `/projects/${ids.otherProjectId}`);
    await page.getByTestId("capture-origin-card").waitFor();
    await capture(page, `${prefix}-shared-source-project-summary`);

    await goto(page, `/projects/${ids.projectId}/timeline`);
    await capture(page, `${prefix}-project-timeline`);

    await goto(page, `/projects/${ids.projectId}/comparison`);
    await capture(page, `${prefix}-project-comparison`);

    await goto(page, `/photos/${ids.photoId}`);
    await capture(page, `${prefix}-photo-detail`);
    await capture(page, `${prefix}-quick-milestone-entry`);
    await capture(page, `${prefix}-photo-detail-plant-crops`);
    await capture(page, `${prefix}-edit-photo-state`);

    await page.getByLabel("Add plant crop").selectOption(ids.secondPlantId);
    await page.getByRole("button", { name: "Set Plant Crop" }).click();
    await capture(page, `${prefix}-crop-initial-no-preset`);

    // No preset or crop history yet - draw the crop from scratch.
    const firstCropStage = page.getByTestId("crop-editor-stage");
    const firstCropBox = await firstCropStage.boundingBox();
    if (!firstCropBox) {
      throw new Error("crop editor stage did not render");
    }
    await page.mouse.move(firstCropBox.x + firstCropBox.width * 0.2, firstCropBox.y + firstCropBox.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(firstCropBox.x + firstCropBox.width * 0.5, firstCropBox.y + firstCropBox.height * 0.5, { steps: 5 });
    await page.mouse.up();

    await page.getByRole("button", { name: "Save size as project default" }).click();
    await page.getByRole("button", { name: "Set initial crop" }).click();

    // Create a third plant to demonstrate the project preset suggesting a
    // same-sized movable crop rectangle for the next uncropped plant.
    await goto(page, `/projects/${ids.projectId}`);
    await page.getByTestId("grid-cell-2-0").click();
    await page.getByLabel("Name").fill("Radish C");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("heading", { name: "Create Plant" }).waitFor({ state: "hidden" });
    await goto(page, `/photos/${ids.photoId}`);
    await page.getByLabel("Add plant crop").selectOption({ label: "Radish C" });
    await page.getByRole("button", { name: "Set Plant Crop" }).click();
    await page.getByTestId("crop-editor-stage").waitFor();
    await page.getByRole("button", { name: "Set initial crop" }).waitFor({ state: "visible" });
    await capture(page, `${prefix}-crop-preset-suggestion`);
    await page.getByRole("button", { name: "Cancel" }).click();

    // Guided project crop setup, at a moment where all three states exist:
    // Radish A still only has its seeded legacy crop (no version yet - that
    // happens later below), Radish B was just configured above, and Radish
    // C has none. Skip through without adopting Radish A's legacy crop here
    // so the "Adjust Crop" steps further down still see it as unconfigured.
    await goto(page, `/projects/${ids.projectId}`);
    await capture(page, `${prefix}-project-crop-status`);

    await page.getByRole("link", { name: "Configure Project Crops" }).click();
    await page.getByTestId("crop-setup-progress").waitFor();
    await capture(page, `${prefix}-crop-setup-legacy-adoption`);

    await page.getByRole("button", { name: "Skip Plant" }).click();
    await capture(page, `${prefix}-crop-setup-progress-plant2`);

    await page.getByRole("button", { name: "Skip Plant" }).click();
    await capture(page, `${prefix}-crop-setup-preset-and-remaining`);

    await page.getByRole("button", { name: "Set Initial Crop & Next" }).click();
    await page.getByTestId("crop-setup-complete").waitFor();
    await capture(page, `${prefix}-crop-setup-complete`);

    await page.getByRole("link", { name: "Back to Project" }).click();
    await page.getByRole("heading", { name: "Crop Setup" }).waitFor();
    await capture(page, `${prefix}-project-crop-status-after-setup`);

    await page.getByRole("button", { name: "Sync Visual Histories" }).click();
    await page.getByText("Visual histories synchronized").waitFor();
    await capture(page, `${prefix}-project-sync-result`);

    await goto(page, `/photos/${ids.photoId}`);
    await page.getByTestId("grid-cell-0-0").click();
    await capture(page, `${prefix}-add-event-dialog`);
    await page.getByRole("button", { name: "Select crop from photo" }).click();
    await capture(page, `${prefix}-event-crop-selector`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/plants/${ids.plantId}`);
    await capture(page, `${prefix}-plant-detail`);
    await capture(page, `${prefix}-plant-milestone-progress`);
    await capture(page, `${prefix}-harvest-result-form`);
    await page.getByTestId("visual-history-status").waitFor();
    await capture(page, `${prefix}-plant-visual-history`);
    await capture(page, `${prefix}-edit-plant-state`);

    await page.getByRole("button", { name: "Next" }).click();
    await capture(page, `${prefix}-plant-visual-history-event`);

    await page.getByRole("button", { name: "Record Observation" }).click();
    await capture(page, `${prefix}-record-observation-from-frame`);
    await page.getByRole("button", { name: "Cancel" }).click();

    // Adjust the crop from this frame forward - Radish A's seeded crops
    // have no crop version yet, so this becomes its first version.
    await page.getByRole("button", { name: "Adjust Crop" }).click();
    await capture(page, `${prefix}-crop-adjust-from-frame`);
    await page.getByRole("button", { name: "Set initial crop" }).click();

    // Move to the last frame and adjust again, creating a second version -
    // demonstrating multiple crop-version boundaries for one plant.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Adjust Crop" }).click();
    await page.getByRole("button", { name: "Adjust crop from this frame forward" }).click();
    await page.getByRole("button", { name: "Adjust Crop" }).click();
    await page.getByText("Advanced").click();
    await capture(page, `${prefix}-crop-version-boundaries`);

    await page.getByRole("button", { name: "Fill missing frames" }).click();
    await capture(page, `${prefix}-crop-missing-frame-repair`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Edit" }).first().click();
    await capture(page, `${prefix}-edit-event-state`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/plants/${ids.secondPlantId}`);
    await capture(page, `${prefix}-plant-visual-history-empty`);

    await goto(page, `/projects/${ids.projectId}/gallery/2026-07`);
    await capture(page, `${prefix}-month-gallery`);

    await goto(page, `/projects/${ids.projectId}/gallery/2026-07/10`);
    await capture(page, `${prefix}-day-photo-grid`);

    await captureNodeSurfaces(page, prefix);
  });
}
