import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

if (process.env.PLANTLAB_SCREENSHOTS_LIVE_READONLY !== "1") {
  throw new Error("tests/live-readonly-screenshots.spec.ts is only for PLANTLAB_SCREENSHOTS_LIVE_READONLY=1 support collection.");
}

type SupportScreenshotRoute = {
  route: string;
  title: string;
  host: string;
  readiness?: "environment" | "project" | "charts" | "hardware" | "generic";
};

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

async function readRoutes(): Promise<SupportScreenshotRoute[]> {
  const manifestPath = process.env.PLANTLAB_SUPPORT_SCREENSHOT_ROUTES_JSON;
  if (!manifestPath) {
    return [
      { route: "/", title: "Dashboard", host: "coordinator", readiness: "generic" },
      { route: "/support", title: "Support", host: "coordinator", readiness: "generic" },
    ];
  }
  const parsed = JSON.parse(await readFile(path.resolve(process.cwd(), manifestPath), "utf8")) as { routes?: SupportScreenshotRoute[] };
  return Array.isArray(parsed.routes) ? parsed.routes : [];
}

async function capture(page: Page, route: SupportScreenshotRoute, index: number): Promise<ScreenshotMetadata> {
  const outputDir = path.join(process.cwd(), "artifacts", "screenshots");
  await mkdir(outputDir, { recursive: true });
  const filename = `${String(index + 1).padStart(3, "0")}-${slug(route.host)}-${slug(route.title || route.route)}.png`;
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim());
  });
  const response = await gotoForResponse(page, route.route);
  const readiness = await waitForSupportReadiness(page, route.readiness ?? "generic");
  await page.screenshot({
    path: path.join(outputDir, filename),
    fullPage: true,
  });
  return {
    route: route.route,
    title: await page.title(),
    host: route.host,
    viewport: page.viewportSize() ?? { width: 0, height: 0 },
    capturedAt: new Date().toISOString(),
    httpStatus: response?.status() ?? null,
    consoleErrors,
    networkErrors,
    outputFilename: filename,
    ready: readiness.ready,
    readinessReason: readiness.reason,
  };
}

test("live readonly support screenshot surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const routes = await readRoutes();
  test.setTimeout(Math.max(90_000, routes.length * 20_000));
  const metadata: ScreenshotMetadata[] = [];

  for (const [index, route] of routes.entries()) {
    metadata.push(await capture(page, route, index));
    await writeMetadata(metadata);
  }

  await writeMetadata(metadata);
  expect(metadata.filter((item) => !item.ready)).toEqual([]);
});

async function writeMetadata(metadata: ScreenshotMetadata[]) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify({ screenshots: metadata }, null, 2)}\n`);
}

async function waitForSupportReadiness(page: Page, readiness: NonNullable<SupportScreenshotRoute["readiness"]>) {
  await expect(page.locator("body")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  const loading = page.getByText(/Loading [^.]+\.{3}/i);
  try {
    await expect(loading).toHaveCount(0, { timeout: readiness === "environment" || readiness === "charts" ? 45_000 : 20_000 });
  } catch {
    return { ready: false, reason: "loading indicator still visible" };
  }
  if (readiness === "environment" || readiness === "charts") {
    await page.locator("svg, canvas, table, [data-chart]").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  }
  return { ready: true, reason: null };
}

function slug(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function gotoForResponse(page: Page, url: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(500);
    }
  }
  return null;
}
