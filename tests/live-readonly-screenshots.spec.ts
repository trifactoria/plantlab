import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { goto } from "./helpers/navigation";

if (process.env.PLANTLAB_SCREENSHOTS_LIVE_READONLY !== "1") {
  throw new Error("tests/live-readonly-screenshots.spec.ts is only for PLANTLAB_SCREENSHOTS_LIVE_READONLY=1 support collection.");
}

async function capture(page: Page, name: string) {
  const outputDir = path.join(process.cwd(), "artifacts", "screenshots");
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage: true,
  });
}

test("live readonly coordinator overview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });

  await goto(page, "/");
  await expect(page.locator("body")).toBeVisible();
  await capture(page, "live-readonly-home");

  const nodeRoutes = [
    "/nodes/greenhouse-zero",
    "/nodes/greenhouse-zero/sensors",
    "/nodes/greenhouse-zero/cameras",
    "/nodes/greenhouse-zero/power",
    "/nodes/greenhouse-zero/activity",
  ];

  for (const route of nodeRoutes) {
    await goto(page, route);
    await expect(page.locator("body")).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await capture(page, `live-readonly-${route.replace(/^\//, "").replaceAll("/", "-")}`);
  }
});
