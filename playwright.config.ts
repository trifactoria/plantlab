import { defineConfig, devices } from "@playwright/test";

const port = process.env.PORT ?? "3000";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const reuseExistingServer =
  process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1" ||
  (process.env.PLANTLAB_SCREENSHOTS_FIXTURE_ONLY !== "1" && process.env.PLANTLAB_SCREENSHOTS_LIVE_READONLY !== "1");

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/playwright-dev-server.mjs",
    url: baseURL,
    reuseExistingServer,
    // The fixture/live-readonly support-bundle runs build a fresh server
    // before the suite, which can exceed the default two minutes.
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
