import { expect, test } from "@playwright/test";
import { readNodeConfig, writeNodeConfig, writeNodeConfigRaw } from "../src/lib/operations/config";
import { ingestPowerState, parsePowerStateReport } from "../src/lib/operations/powerProtocol";
import { registerOrRotateNode } from "../src/lib/operations/nodeCredentials";
import { createPowerSchedule } from "../src/lib/operations/powerSchedule";
import { prisma } from "../src/lib/prisma";
import { goto } from "./helpers/navigation";

const NODE_NAME = "e2e-power-node";

async function seedNode(outlets: Array<Record<string, unknown>>) {
  const registered = await registerOrRotateNode(prisma, { name: NODE_NAME, role: "greenhouse-node", rotateCredential: true });
  await ingestPowerState(prisma, registered.node.id, parsePowerStateReport({ outlets }, new Date()));
  return registered;
}

async function cleanupNode() {
  await prisma.plantLabNode.deleteMany({ where: { name: NODE_NAME } });
}

test.describe("generic outlet rendering (normal Water, pulse-only, and unknown outlet keys)", () => {
  test.beforeEach(async () => {
    await cleanupNode();
  });
  test.afterEach(async () => {
    await cleanupNode();
  });

  test("a normal Water outlet renders ordinary ON and OFF controls, same as any other normal outlet", async ({ page }) => {
    await seedNode([
      { key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", behavior: "normal", actualState: false, available: true },
      { key: "lights", name: "Lights", provider: "kasa", providerAlias: "lights", behavior: "normal", actualState: false, available: true },
      { key: "water", name: "Water", provider: "kasa", providerAlias: "water", behavior: "normal", actualState: false, available: true },
    ]);
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      const waterCard = page.locator("div", { has: page.getByRole("heading", { name: "Water", exact: true }) }).first();
      await expect(waterCard.getByRole("button", { name: "Turn Water on" })).toBeVisible();
      await expect(waterCard.getByRole("button", { name: "Turn Water off" })).toBeVisible();
      await expect(waterCard.getByText("Pulse-only", { exact: false })).toHaveCount(0);
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("outlet rendering is driven by API data, not a fixed key list - a non-standard outlet key still renders", async ({ page }) => {
    // The coordinator-to-edge power protocol (POWER_OUTLET_KEYS in
    // powerProtocol.ts) still enforces a known outlet key allowlist at
    // ingestion time - that boundary is part of the not-yet-built desired/
    // applied configuration control plane and is intentionally out of scope
    // for this task. Insert the extra outlet row directly to prove the
    // *frontend* renders whatever NodeOutlet rows exist rather than
    // hardcoding to a fixed key list, independent of that ingestion-layer
    // restriction.
    const registered = await seedNode([{ key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", behavior: "normal", actualState: false, available: true }]);
    await prisma.nodeOutlet.create({
      data: {
        nodeId: registered.node.id,
        key: "co2-injector",
        name: "CO2 Injector",
        provider: "kasa",
        providerAlias: "co2",
        enabled: true,
        behavior: "normal",
        safetyClass: "switch",
        actualState: false,
        available: true,
      },
    });
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      await expect(page.getByRole("heading", { name: "CO2 Injector", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Turn CO2 Injector on" })).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("a pulse-only outlet has no permanent ON control but keeps OFF", async ({ page }) => {
    await seedNode([{ key: "water", name: "Water", provider: "kasa", providerAlias: "water", behavior: "pulse-only", actualState: false, available: true }]);
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      const waterCard = page.locator("div", { has: page.getByRole("heading", { name: "Water", exact: true }) }).first();
      await expect(waterCard.getByRole("button", { name: "Turn Water on" })).toHaveCount(0);
      await expect(waterCard.getByRole("button", { name: "Turn Water off" })).toBeVisible();
      await expect(waterCard.getByText(/Pulse-only outlet/)).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });
});

test.describe("daily timer form outlet/action options", () => {
  test.beforeEach(async () => {
    await cleanupNode();
  });
  test.afterEach(async () => {
    await cleanupNode();
  });

  test("timer outlet choices include normal Water alongside fans and lights", async ({ page }) => {
    await seedNode([
      { key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", behavior: "normal", actualState: false, available: true },
      { key: "lights", name: "Lights", provider: "kasa", providerAlias: "lights", behavior: "normal", actualState: false, available: true },
      { key: "water", name: "Water", provider: "kasa", providerAlias: "water", behavior: "normal", actualState: false, available: true },
    ]);
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      // Options are populated asynchronously from the power API - wait for Water to appear.
      await expect(page.locator('form:has(h4:has-text("Add a timer")) select option[value="water"]')).toHaveCount(1);
      const options = await page.locator('form:has(h4:has-text("Add a timer")) select').first().locator("option").allTextContents();
      expect(options).toEqual(expect.arrayContaining(["Fans", "Lights", "Water"]));
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("selecting a pulse-only outlet in the timer form removes the ON action option", async ({ page }) => {
    await seedNode([
      { key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", behavior: "normal", actualState: false, available: true },
      { key: "water", name: "Water", provider: "kasa", providerAlias: "water", behavior: "pulse-only", actualState: false, available: true },
    ]);
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      const form = page.locator('form:has(h4:has-text("Add a timer"))');
      const outletSelect = form.locator("select").first();
      const actionSelect = form.locator("select").nth(1);

      await expect(form.locator('select option[value="water"]')).toHaveCount(1);
      await expect(actionSelect.locator('option[value="on"]')).toHaveCount(1);

      await outletSelect.selectOption("water");
      await expect(actionSelect.locator('option[value="on"]')).toHaveCount(0);
      await expect(actionSelect.locator('option[value="off"]')).toHaveCount(1);
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("editing an existing schedule still shows its configured outlet correctly", async ({ page }) => {
    const registered = await seedNode([
      { key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", behavior: "normal", actualState: false, available: true },
      { key: "lights", name: "Lights", provider: "kasa", providerAlias: "lights", behavior: "normal", actualState: false, available: true },
    ]);
    await createPowerSchedule(prisma, registered.node.name, { outletKey: "lights", action: "on", timeOfDay: "07:00", label: "Morning lights" });

    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);
      await expect(page.getByText("Morning lights")).toBeVisible();
      await page.getByRole("button", { name: "Edit" }).click();
      const form = page.locator('form:has(h4:has-text("Edit timer"))');
      await expect(form.locator("select").first()).toHaveValue("lights");
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });
});

test.describe("node subsystem navigation", () => {
  test.beforeEach(async () => {
    await cleanupNode();
  });
  test.afterEach(async () => {
    await cleanupNode();
  });

  test("subsystem summary cards navigate to their dedicated pages", async ({ page }) => {
    await seedNode([{ key: "fans", name: "Fans", provider: "kasa", providerAlias: "fans", behavior: "normal", actualState: false, available: true }]);
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}`);

      await page.getByRole("link", { name: /^Sensors/ }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/sensors$`));
      await expect(page.getByRole("heading", { name: "Sensor management", exact: true })).toBeVisible();

      await goto(page, `/nodes/${NODE_NAME}`);
      await page.getByRole("link", { name: /^Power outlets/ }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/power$`));
      await expect(page.getByRole("heading", { name: "Power", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Fans", exact: true })).toBeVisible();

      await goto(page, `/nodes/${NODE_NAME}`);
      await page.getByRole("link", { name: /^Cameras/ }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/cameras$`));
      await expect(page.getByRole("heading", { name: "Camera management", exact: true })).toBeVisible();

      await goto(page, `/nodes/${NODE_NAME}`);
      await page.getByRole("link", { name: "View full activity →" }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/activity$`));
      await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("the sensors list page links to each sensor's detail page", async ({ page }) => {
    const { ingestEnvironmentTelemetry, parseEnvironmentBatch } = await import("../src/lib/operations/environmentProtocol");
    const registered = await seedNode([]);
    await ingestEnvironmentTelemetry(
      prisma,
      registered.node.id,
      parseEnvironmentBatch({
        events: [
          {
            eventId: "seed-1",
            sensor: { key: "greenhouse-outside", name: "Greenhouse Outside", type: "dht22", gpio: 4, placement: "outside", enabled: true },
            capturedAt: new Date().toISOString(),
            classification: "accepted",
            temperatureC: 21,
            humidityPct: 50,
            diagnosticCode: null,
            diagnosticMessage: null,
          },
        ],
      }),
    );

    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, `/nodes/${NODE_NAME}/sensors`);
      await page.getByRole("link", { name: "Greenhouse Outside" }).click();
      await expect(page).toHaveURL(new RegExp(`/nodes/${NODE_NAME}/sensors/greenhouse-outside$`));
      await expect(page.getByRole("heading", { name: "Greenhouse Outside", level: 1 })).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });
});
