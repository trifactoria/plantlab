import { expect, test } from "@playwright/test";
import { disconnectPrisma, mockCameraApis, seedVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

test.afterAll(async () => {
  await disconnectPrisma();
});

test("core CRUD screens render and open edit surfaces", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, "/");
  await expect(page.getByRole("heading", { name: "Local plant experiment tracker" })).toBeVisible();
  await expect(page.getByText("Playwright Radish Study")).toBeVisible();

  await page.getByLabel("Name").fill("Playwright Auto Folder Project");
  await expect(page.getByLabel("Camera")).toContainText("Mock USB Camera");
  await expect(page.getByText("Create and use a PlantLab photo folder")).toBeVisible();
  await expect(page.getByLabel("Schedule starting date and time")).toBeVisible();
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Playwright Auto Folder Project" })).toBeVisible();
  const createdProjectId = page.url().split("/").filter(Boolean).at(-1);
  if (createdProjectId) {
    await page.request.delete(`/api/projects/${createdProjectId}`);
  }

  await goto(page, `/projects/${ids.projectId}`);
  await expect(page.getByRole("heading", { name: "Playwright Radish Study" })).toBeVisible();
  await expect(page.getByText("June 2026")).toBeVisible();
  await expect(page.getByText("July 2026")).toBeVisible();

  await page.getByTestId("grid-cell-2-2").click();
  await expect(page.getByRole("heading", { name: "Create Plant" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await goto(page, `/projects/${ids.projectId}/settings`);
  await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Settings" })).toBeVisible();
  await expect(page.getByLabel("Camera")).toContainText("Mock USB Camera");
  await expect(page.getByLabel("Schedule starting date and time")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/camera`);
  await expect(page.getByRole("heading", { name: "Camera Setup" })).toBeVisible();
  await expect(page.getByText("Preview is idle")).toBeVisible();
  await expect(page.getByText("Focus Auto")).toBeVisible();
  await expect(page.getByText("Exposure Auto")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/gallery/2026-07`);
  await expect(page.getByRole("heading", { name: "July 2026" })).toBeVisible();
  await expect(page.getByText("Friday, July 10, 2026")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/gallery/2026-07/10`);
  await expect(page.getByRole("heading", { name: "Friday, July 10, 2026" })).toBeVisible();
  await expect(page.getByText("1 event")).toBeVisible();

  await goto(page, `/photos/${ids.photoId}`);
  await expect(page.getByRole("heading", { name: "Edit Photo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Linked Events" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Photo" }).click();
  await expect(page.getByRole("heading", { name: "Delete Photo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("grid-cell-0-0").click();
  await expect(page.getByRole("heading", { name: "Add Event" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await goto(page, `/plants/${ids.plantId}`);
  await expect(page.getByRole("heading", { name: "Edit Plant" })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByRole("heading", { name: "Edit Event" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});
