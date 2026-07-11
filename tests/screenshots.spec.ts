import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { disconnectPrisma, mockCameraApis, seedVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1024, height: 768 },
];

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

    await goto(page, `/projects/${ids.projectId}`);
    await capture(page, `${prefix}-project-dashboard`);
    await capture(page, `${prefix}-manual-photo-upload`);

    await page.getByTestId("grid-cell-2-2").click();
    await capture(page, `${prefix}-create-plant-dialog`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/projects/${ids.projectId}/settings`);
    await capture(page, `${prefix}-project-settings`);

    await page.getByRole("button", { name: "Delete Project" }).click();
    await capture(page, `${prefix}-delete-confirmation`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/projects/${ids.projectId}/camera`);
    await capture(page, `${prefix}-camera-setup-idle`);

    await goto(page, `/projects/${ids.projectId}/timeline`);
    await capture(page, `${prefix}-project-timeline`);

    await goto(page, `/photos/${ids.photoId}`);
    await capture(page, `${prefix}-photo-detail`);
    await capture(page, `${prefix}-photo-detail-plant-crops`);
    await capture(page, `${prefix}-edit-photo-state`);

    await page.getByRole("combobox").selectOption(ids.secondPlantId);
    await page.getByRole("button", { name: "Set Plant Crop" }).click();
    await capture(page, `${prefix}-plant-crop-editor`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByTestId("grid-cell-0-0").click();
    await capture(page, `${prefix}-add-event-dialog`);
    await page.getByRole("button", { name: "Select crop from photo" }).click();
    await capture(page, `${prefix}-event-crop-selector`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await goto(page, `/plants/${ids.plantId}`);
    await capture(page, `${prefix}-plant-detail`);
    await capture(page, `${prefix}-plant-visual-history`);
    await capture(page, `${prefix}-edit-plant-state`);

    await page.getByRole("button", { name: "Next" }).click();
    await capture(page, `${prefix}-plant-visual-history-event`);

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
