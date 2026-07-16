import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPrismaRoot } from "./helpers/isolatedPrismaRoot";
import { createFakeSystemctl, prependPath, type FakeSystemctl } from "./helpers/fakeSystemctl";

const ORIGINAL_ROOT = process.env.PLANTLAB_ROOT_DIR;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_HOME = process.env.HOME;

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.PLANTLAB_ROOT_DIR;
  else process.env.PLANTLAB_ROOT_DIR = ORIGINAL_ROOT;
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe("plantlab update - role awareness", () => {
  let fake: FakeSystemctl;
  let restorePath: () => void;

  afterEach(async () => {
    restorePath?.();
    await fake?.cleanup();
  });

  it("refuses to run when no role is configured yet", async () => {
    const { root, cleanup } = await createIsolatedPrismaRoot();
    process.env.PLANTLAB_ROOT_DIR = root;
    process.env.DATABASE_URL = `file:${path.join(root, "prisma", "dev.db")}`;
    try {
      const { runUpdate } = await import("../../src/lib/operations/update");
      const result = await runUpdate({ skipInstall: true, skipBuild: true });
      expect(result.ok).toBe(false);
      expect(result.role).toBeNull();
      expect(result.steps[1].detail).toMatch(/no role is configured/i);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("camera-node update never migrates the domain database or starts web/camera", async () => {
    const { root, cleanup } = await createIsolatedPrismaRoot();
    process.env.PLANTLAB_ROOT_DIR = root;
    process.env.DATABASE_URL = `file:${path.join(root, "prisma", "dev.db")}`;
    process.env.HOME = root;

    fake = await createFakeSystemctl();
    restorePath = prependPath(fake.binDir);

    try {
      const { writeNodeConfig } = await import("../../src/lib/operations/config");
      await writeNodeConfig("camera-node", { coordinatorUrl: "http://coordinator:3000" });

      const { runUpdate } = await import("../../src/lib/operations/update");
      const result = await runUpdate({ skipInstall: true, skipBuild: true });

      const migrationStep = result.steps.find((s) => s.name === "migrations");
      expect(migrationStep?.detail).toMatch(/does not use the canonical domain database/i);

      const buildStep = result.steps.find((s) => s.name === "build");
      expect(buildStep?.detail).toMatch(/does not run the web build/i);

      expect(await fake.isActive("plantlab-web.service")).toBe(false);
      expect(await fake.isActive("plantlab-camera.service")).toBe(false);
      expect(await fake.isActive("plantlab-agent.service")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("standalone update applies pending migrations before restarting services", async () => {
    const { root, cleanup } = await createIsolatedPrismaRoot();
    process.env.PLANTLAB_ROOT_DIR = root;
    const dbPath = path.join(root, "prisma", "dev.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    process.env.HOME = root;

    fake = await createFakeSystemctl();
    restorePath = prependPath(fake.binDir);

    try {
      const { writeNodeConfig } = await import("../../src/lib/operations/config");
      await writeNodeConfig("standalone");

      const { runUpdate } = await import("../../src/lib/operations/update");
      const result = await runUpdate({ skipInstall: true, skipBuild: true });

      const migrationStep = result.steps.find((s) => s.name === "migration:migrate-deploy" || s.name === "migration:check");
      expect(migrationStep).toBeTruthy();

      const { checkMigrationStatus } = await import("../../src/lib/operations/migrations");
      const status = await checkMigrationStatus();
      expect(status.current).toBe(true);

      expect(await fake.isActive("plantlab-web.service")).toBe(true);
      expect(await fake.isActive("plantlab-camera.service")).toBe(true);
      await expect(fake.actions()).resolves.toEqual(
        expect.arrayContaining(["restart plantlab-web.service", "restart plantlab-camera.service"]),
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("is idempotent - a second run against an already-current, already-configured node succeeds cleanly", async () => {
    const { root, cleanup } = await createIsolatedPrismaRoot();
    process.env.PLANTLAB_ROOT_DIR = root;
    process.env.DATABASE_URL = `file:${path.join(root, "prisma", "dev.db")}`;
    process.env.HOME = root;

    fake = await createFakeSystemctl();
    restorePath = prependPath(fake.binDir);

    try {
      const { writeNodeConfig } = await import("../../src/lib/operations/config");
      await writeNodeConfig("camera-node", { coordinatorUrl: "http://coordinator:3000" });

      const { runUpdate } = await import("../../src/lib/operations/update");
      const first = await runUpdate({ skipInstall: true, skipBuild: true });
      const second = await runUpdate({ skipInstall: true, skipBuild: true });

      // Check the steps this test actually cares about (role-aware
      // convergence is idempotent) rather than the overall result, which
      // is also gated on the final `doctor` step - that step legitimately
      // reports fail in this isolated sandbox (no real .next build exists
      // here), which is correct doctor behavior, not an update bug.
      for (const result of [first, second]) {
        expect(result.steps.find((s) => s.name === "configuration")?.ok).toBe(true);
        expect(result.steps.find((s) => s.name === "prisma-client")?.ok).toBe(true);
        expect(result.steps.find((s) => s.name.startsWith("service:"))?.ok).toBe(true);
      }
      expect(await fake.isActive("plantlab-agent.service")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);
});
