import { expect, test } from "@playwright/test";
import { cleanupNodeVisualData, NODE_VISUAL_NAME, seedNodeVisualData } from "./helpers/devData";
import { prisma } from "../src/lib/prisma";
import { goto } from "./helpers/navigation";

// Isolated fixture node only - seed/cleanup both assert the fixture database.
test.beforeEach(async () => {
  await seedNodeVisualData();
});
test.afterEach(async () => {
  await cleanupNodeVisualData();
});
test.afterAll(async () => {
  await prisma.$disconnect();
});

async function sourceIdForCamera(cameraName: string) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { name: NODE_VISUAL_NAME } });
  const camera = await prisma.nodeCamera.findFirstOrThrow({ where: { nodeId: node.id, name: cameraName } });
  return camera.captureSourceId!;
}

test.describe("remote shelf-camera configuration", () => {
  test("uses the user display name as the title and hardware name as secondary, with real verified modes", async ({ page }) => {
    // The coordinator must never fall back to local V4L2 discovery for a
    // node-backed camera's capabilities.
    let localCamerasCalled = false;
    await page.route("**/api/cameras", (route) => {
      localCamerasCalled = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cameras: [] }) });
    });

    const sourceId = await sourceIdForCamera("Greenhouse Wide");
    await goto(page, `/capture-sources/${sourceId}`);

    // Display name is the primary title (not the raw source/hardware name).
    await expect(page.getByRole("heading", { name: "Greenhouse Wide", level: 1 })).toBeVisible();
    await expect(page.getByTestId("camera-display-name")).toHaveText("Greenhouse Wide");

    // Verified modes populate the selector, including 1920x1080; no capability-missing state.
    const modeSelect = page.getByTestId("camera-mode-select");
    await expect(modeSelect).toBeVisible();
    await expect(page.getByTestId("camera-capability-missing")).toHaveCount(0);
    await expect(modeSelect.getByRole("option", { name: /1920 × 1080/ })).toHaveCount(1);

    // Save is available (not gated behind an unverified fallback), and the
    // canonical config identity is used.
    await expect(page.getByTestId("camera-save")).toBeVisible();

    // The shelf layout (project-area) editor is preserved below the config.
    await expect(page.getByRole("heading", { name: "Shelf Layout" })).toBeVisible();

    expect(localCamerasCalled).toBe(false);
  });

  test("lets the user select and persist 1920x1080 without downgrading", async ({ page }) => {
    const sourceId = await sourceIdForCamera("Greenhouse Wide");
    const camera = await prisma.nodeCamera.findFirstOrThrow({ where: { name: "Greenhouse Wide" } });
    await goto(page, `/capture-sources/${sourceId}`);

    // Select by the stable mode option value (inputFormat:WxH).
    await page.getByTestId("camera-mode-select").selectOption("mjpeg:1920x1080");
    await page.getByTestId("camera-save").click();
    // Save waits for the PATCH plus a canonical-summary reload (route compiles
    // on first hit under next dev), so allow extra time before the notice.
    await expect(page.getByTestId("camera-save-notice")).toContainText("1920×1080", { timeout: 20_000 });

    const assignment = await prisma.nodeCameraAssignment.findFirstOrThrow({ where: { nodeCameraId: camera.id, active: true } });
    expect(assignment.width).toBe(1920);
    expect(assignment.height).toBe(1080);
  });
});
