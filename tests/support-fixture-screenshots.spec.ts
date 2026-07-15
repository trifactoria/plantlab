import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { cleanupNodeVisualData, disconnectPrisma, NODE_VISUAL_NAME, seedNodeVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

// A deliberately small fixture screenshot pass for the support bundle. It
// mutates only isolated fixture data (seedNodeVisualData/cleanupNodeVisualData
// both call assertFixtureDatabase() and refuse a live-looking DB), and
// captures just the homepage and node overview so it compiles quickly even on
// the coordinator, which shares CPU with the live services. The full
// desktop/laptop/mobile suite lives in tests/screenshots.spec.ts.
if (process.env.PLANTLAB_SCREENSHOTS_LIVE_READONLY === "1") {
  throw new Error("tests/support-fixture-screenshots.spec.ts mutates fixture data and must never run in live-readonly mode.");
}

async function capture(page: Page, name: string) {
  const outputDir = path.join(process.cwd(), "artifacts", "screenshots");
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true });
}

test.afterAll(async () => {
  await cleanupNodeVisualData();
  await disconnectPrisma();
});

test("fixture support screenshots (isolated synthetic data)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await seedNodeVisualData();

  await goto(page, "/");
  await expect(page.getByRole("link", { name: NODE_VISUAL_NAME, exact: true })).toBeVisible();
  await capture(page, "fixture-home-with-node");

  await goto(page, `/nodes/${NODE_VISUAL_NAME}`);
  // The hardware-config strip is client-rendered after an async fetch that
  // compiles the /api/nodes/[nodeName] route on first hit under next dev - a
  // generous timeout keeps this reliable on the CPU-shared coordinator.
  await expect(page.getByText("Hardware configuration")).toBeVisible({ timeout: 45_000 });
  await capture(page, "fixture-node-overview");
});
