import { mkdir, writeFile } from "node:fs/promises";
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

type ScreenshotMetadata = {
  route: string;
  title: string;
  host: string;
  viewport: { width: number; height: number };
  capturedAt: string;
  httpStatus: number | null;
  consoleErrors: string[];
  networkErrors: string[];
  outputFilename: string;
  ready: boolean;
  readinessReason: string | null;
};

const outputDir = path.join(process.cwd(), "artifacts", "screenshots");

async function capture(page: Page, route: string, name: string): Promise<ScreenshotMetadata> {
  await mkdir(outputDir, { recursive: true });
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
  return {
    route,
    title: await page.title(),
    host: "fixture",
    viewport: page.viewportSize() ?? { width: 0, height: 0 },
    capturedAt: new Date().toISOString(),
    httpStatus: null,
    consoleErrors: [],
    networkErrors: [],
    outputFilename: filename,
    ready: true,
    readinessReason: null,
  };
}

test.afterAll(async () => {
  await cleanupNodeVisualData();
  await disconnectPrisma();
});

test("fixture support screenshots (isolated synthetic data)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await seedNodeVisualData();
  const metadata: ScreenshotMetadata[] = [];

  await goto(page, "/");
  await expect(page.getByRole("link", { name: NODE_VISUAL_NAME, exact: true })).toBeVisible();
  metadata.push(await capture(page, "/", "fixture-home-with-node"));

  await goto(page, `/nodes/${NODE_VISUAL_NAME}`);
  // The hardware-config strip is client-rendered after an async fetch that
  // compiles the /api/nodes/[nodeName] route on first hit under next dev - a
  // generous timeout keeps this reliable on the CPU-shared coordinator.
  await expect(page.getByText("Hardware configuration")).toBeVisible({ timeout: 45_000 });
  metadata.push(await capture(page, `/nodes/${NODE_VISUAL_NAME}`, "fixture-node-overview"));
  await writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify({ screenshots: metadata }, null, 2)}\n`);
});
