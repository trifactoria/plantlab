import { expect, test } from "@playwright/test";
import { readNodeConfig, writeNodeConfig, writeNodeConfigRaw } from "../src/lib/operations/config";
import { ingestEnvironmentTelemetry, parseEnvironmentBatch } from "../src/lib/operations/environmentProtocol";
import { registerOrRotateNode } from "../src/lib/operations/nodeCredentials";
import { ingestPowerState, parsePowerStateReport } from "../src/lib/operations/powerProtocol";
import { prisma } from "../src/lib/prisma";
import { goto } from "./helpers/navigation";

const NODE_NAME = "e2e-diagnostics-node";

// GreenhousePanel (shared with the existing greenhouse-zero dashboard) only
// renders the four canonical sensor keys/labels below - a node with a
// different sensor key set would have no clickable sensor cards via that
// panel today. Using the real canonical keys here matches the only
// sensor-bearing node that actually exists in production and documents
// this as a known scope limitation (see the deliverable report) rather
// than silently working around it with made-up keys that would never
// render as cards at all.
const HEALTHY_SENSOR_KEY = "greenhouse-outside";
const HEALTHY_SENSOR_LABEL = "Outside";
const FAILED_SENSOR_KEY = "greenhouse-middle";
const FAILED_SENSOR_LABEL = "Middle shelf";

function envEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sensor: { key: HEALTHY_SENSOR_KEY, name: "Greenhouse Outside", type: "dht22", gpio: 2, placement: "test", enabled: true },
    capturedAt: new Date().toISOString(),
    classification: "accepted",
    temperatureC: 22.5,
    humidityPct: 58.0,
    diagnosticCode: null,
    diagnosticMessage: null,
    ...overrides,
  };
}

async function seedNode() {
  const registered = await registerOrRotateNode(prisma, { name: NODE_NAME, role: "greenhouse-node", rotateCredential: true });

  await ingestEnvironmentTelemetry(
    prisma,
    registered.node.id,
    parseEnvironmentBatch({ events: [envEvent({ eventId: "seed-healthy" })] }, new Date()),
  );
  await ingestEnvironmentTelemetry(
    prisma,
    registered.node.id,
    parseEnvironmentBatch(
      {
        events: [
          envEvent({
            eventId: "seed-failed",
            sensor: { key: FAILED_SENSOR_KEY, name: "Greenhouse Middle Shelf", type: "dht22", gpio: 17, placement: "test", enabled: true },
            classification: "failed",
            temperatureC: null,
            humidityPct: null,
            diagnosticCode: "sensor-no-response",
            diagnosticMessage: "No DHT22 response pulses were received.",
          }),
        ],
      },
      new Date(),
    ),
  );

  await ingestPowerState(
    prisma,
    registered.node.id,
    parsePowerStateReport({
      outlets: [{ key: "fans", name: "Fans", provider: "kasa", providerAlias: "e2e-fans", enabled: true, safetyClass: "switch", actualState: false, available: true }],
    }),
  );

  return registered;
}

async function cleanupNode() {
  await prisma.plantLabNode.deleteMany({ where: { name: NODE_NAME } });
}

test.describe("node and sensor diagnostics navigation", () => {
  test.beforeEach(async () => {
    await cleanupNode();
  });

  test.afterEach(async () => {
    await cleanupNode();
  });

  test("clicking a node name on the coordinator dashboard opens its detail page", async ({ page }) => {
    await seedNode();
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, "/");
      await page.getByRole("link", { name: NODE_NAME, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}$`));
      await expect(page.getByRole("heading", { name: NODE_NAME, exact: true })).toBeVisible();
      await expect(page.getByText("Identity and connectivity")).toBeVisible();
      await expect(page.getByText("greenhouse-node")).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("a healthy sensor card is clickable and its detail page shows Fresh state", async ({ page }) => {
    await seedNode();
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      await page.getByRole("link", { name: new RegExp(HEALTHY_SENSOR_LABEL) }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/sensors/${HEALTHY_SENSOR_KEY}$`));
      await expect(page.getByRole("heading", { name: "Greenhouse Outside" })).toBeVisible();
      await expect(page.getByText("Fresh", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("22.5").first()).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("a failed sensor card shows the failure reason and links to diagnostics with guidance", async ({ page }) => {
    await seedNode();
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      await expect(page.getByText("No DHT22 response pulses were received.").first()).toBeVisible();
      await page.getByRole("link", { name: new RegExp(FAILED_SENSOR_LABEL) }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/sensors/${FAILED_SENSOR_KEY}$`));
      await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("No response from the sensor")).toBeVisible();
      await expect(page.getByText(/verify the sensor has 3\.3v/i)).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("the sensor test lifecycle renders through queued, running, and succeeded states", async ({ page }) => {
    const registered = await seedNode();
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}/sensors/${HEALTHY_SENSOR_KEY}`);
      await expect(page.getByRole("button", { name: "Run sensor test" })).toBeEnabled();
      await page.getByRole("button", { name: "Run sensor test" }).click();
      await expect(page.getByText("Queued")).toBeVisible({ timeout: 10_000 });

      const created = await prisma.sensorTestCommand.findFirstOrThrow({ where: { nodeId: registered.node.id, sensorKey: HEALTHY_SENSOR_KEY } });
      await prisma.sensorTestCommand.update({ where: { id: created.id }, data: { status: "running", claimedAt: new Date(), startedAt: new Date() } });
      await page.reload();
      await expect(page.getByText("Running")).toBeVisible();

      await prisma.sensorTestCommand.update({
        where: { id: created.id },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          finalPass: true,
          attemptsCompleted: 3,
          acceptedCount: 3,
          failedCount: 0,
          effectiveDriver: "pigpio",
          configuredGpio: 2,
          attemptsJson: JSON.stringify([{ attempt: 1, classification: "accepted", code: null, message: null, temperatureC: 22.4, humidityPct: 57.9 }]),
        },
      });
      await page.reload();
      await expect(page.getByText("Succeeded")).toBeVisible();
      await expect(page.getByRole("button", { name: "Run sensor test" })).toBeEnabled();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });
});
