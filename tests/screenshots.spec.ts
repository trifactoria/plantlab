import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { cleanupVisualData, disconnectPrisma, mockCameraApis, seedVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1024, height: 768 },
];

test.afterEach(async () => {
  await cleanupVisualData();
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

for (const viewport of viewports) {
  test(`screenshots ${viewport.name}`, async ({ page }) => {
    await mockCameraApis(page);
    const ids = await seedVisualData();
    const prefix = viewport.name;

    await page.setViewportSize({ width: viewport.width, height: viewport.height });

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
    await page.getByTestId("raw-resolution-select").selectOption({ label: "3840 x 2160 (15.000 fps)" });
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
  });
}
