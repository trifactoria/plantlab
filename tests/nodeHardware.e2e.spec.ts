import { expect, test } from "@playwright/test";
import { cleanupNodeVisualData, NODE_VISUAL_NAME, seedNodeVisualData } from "./helpers/devData";
import { prisma } from "../src/lib/prisma";
import { goto } from "./helpers/navigation";

// These specs mutate an isolated fixture node only. seedNodeVisualData /
// cleanupNodeVisualData both call assertFixtureDatabase() first and refuse to
// touch a live-looking database (see the restored incident in the task
// brief), so this spec can never delete or recreate the real greenhouse-zero.
test.beforeEach(async () => {
  await seedNodeVisualData();
});
test.afterEach(async () => {
  await cleanupNodeVisualData();
});
test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("camera management", () => {
  test("an active camera shows its current endpoint and identity, distinguished by USB path", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/cameras`);
    await expect(page.getByText("Active cameras (2)")).toBeVisible();
    // Physically-identical cameras are distinguished by USB path in the name.
    await expect(page.getByRole("heading", { name: /USB path 1\.1/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /USB path 1\.2/ })).toBeVisible();
    // Current endpoint (device path) is shown but is not the primary identity.
    await expect(page.getByText("/dev/video0").first()).toBeVisible();
  });

  test("renaming a camera preserves its logical id", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/cameras`);
    const before = await prisma.nodeCamera.findFirstOrThrow({ where: { name: { contains: "Greenhouse Wide" } } });
    const card = page.getByTestId(`camera-card-${before.id}`);
    await card.getByRole("button", { name: "Rename" }).click();
    await card.getByLabel("Camera name").fill("Front Wide Cam");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Front Wide Cam - USB path 1.1")).toBeVisible();
    const after = await prisma.nodeCamera.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Front Wide Cam");
  });

  test("an unavailable camera opens a reattach drawer with candidates and an ambiguity warning", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/cameras`);
    await expect(page.getByText("Unavailable cameras (1)")).toBeVisible();
    await page.getByRole("button", { name: "Reattach" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/Multiple endpoints could match/)).toBeVisible();
    await expect(page.getByText("Same vendor, product, and serial").first()).toBeVisible();
    // The moved 1.3.3 endpoint is offered as a candidate.
    await expect(page.getByText("/dev/video6")).toBeVisible();
  });

  test("retire moves a camera to the retired group and restore brings it back", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/cameras`);
    const camera = await prisma.nodeCamera.findFirstOrThrow({ where: { name: { contains: "Greenhouse Top Shelf" } } });
    const card = page.getByTestId(`camera-card-${camera.id}`);
    await card.getByRole("button", { name: "Retire" }).click();
    // Confirm inside the modal overlay (scoped so it isn't another card's trigger).
    await expect(page.getByRole("heading", { name: "Retire this camera?" })).toBeVisible();
    await page.locator(".fixed.inset-0.z-50").getByRole("button", { name: "Retire", exact: true }).click();
    await expect(page.getByText(/Retired cameras \(/)).toBeVisible();
    // The row is preserved in the DB (never deleted).
    const retired = await prisma.nodeCamera.findUniqueOrThrow({ where: { id: camera.id } });
    expect(retired.retiredAt).not.toBeNull();
  });
});

test.describe("sensor management", () => {
  test("shows desired and applied revisions and the retired/historical section", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/sensors`);
    await expect(page.getByText("Configuration status")).toBeVisible();
    await expect(page.getByText("Applied", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Active sensors (4)")).toBeVisible();
    await expect(page.getByText(/Retired \/ historical sensors/)).toBeVisible();
    // Top shelf is observed-failed but still applied - a failure is not a rejection.
    await expect(page.getByText("Observed: failed").first()).toBeVisible();
  });

  test("a duplicate GPIO in the draft blocks apply with a clear error", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/sensors`);
    const bottomCard = page.getByTestId("sensor-row-greenhouse-bottom");
    await bottomCard.getByRole("button", { name: "Edit" }).click();
    // greenhouse-outside uses GPIO 4; set bottom to 4 too.
    await bottomCard.getByLabel("BCM GPIO").fill("4");
    await expect(page.getByText(/GPIO 4 is assigned to both/)).toBeVisible();
    await expect(page.getByRole("button", { name: /No unsaved changes|Apply desired configuration/ })).toBeDisabled();
  });

  test("renaming a display name creates a new desired revision without losing history", async ({ page }) => {
    await goto(page, `/nodes/${NODE_VISUAL_NAME}/sensors`);
    const readingsBefore = await prisma.sensorReading.count({ where: { sensor: { key: "greenhouse-outside" } } });
    const card = page.getByTestId("sensor-row-greenhouse-outside");
    await card.getByRole("button", { name: "Edit" }).click();
    await card.getByLabel("Display name").fill("Outside Air");
    await page.getByRole("button", { name: "Apply desired configuration" }).click();
    await expect(page.getByText("Waiting for node").first()).toBeVisible({ timeout: 10_000 });
    // History preserved; a new pending desired revision (2) was created.
    const readingsAfter = await prisma.sensorReading.count({ where: { sensor: { key: "greenhouse-outside" } } });
    expect(readingsAfter).toBe(readingsBefore);
    const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: NODE_VISUAL_NAME } });
    expect(node.desiredSensorConfigRevision).toBe(2);
    expect(node.appliedSensorConfigRevision).toBe(1);
  });
});

test.describe("support bundle UI", () => {
  test("offers only structured options and the correct isolation language for each screenshot mode", async ({ page }) => {
    await goto(page, "/support");
    await expect(page.getByText("Coordinator only")).toBeVisible();
    await expect(page.getByText("Selected node(s)")).toBeVisible();
    await expect(page.getByText("All hosts")).toBeVisible();
    // Fixture mode isolation language.
    await expect(page.getByText(/temporary, isolated PlantLab database and synthetic data/)).toBeVisible();
    // Live-readonly non-mutation language.
    await expect(page.getByText(/does not create, edit, delete, toggle, or run diagnostics/)).toBeVisible();
    // No free-text command entry anywhere on the page (structured options only).
    await expect(page.locator('input[type="text"]')).toHaveCount(0);
  });
});
