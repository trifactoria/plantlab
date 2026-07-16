import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlantLabEnvFiles, parseEnvFile } from "../../src/lib/envFiles.server";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("PlantLab env file loading", () => {
  it("parses simple quoted and unquoted values", () => {
    expect(parseEnvFile(["# comment", "DATABASE_URL=file:/tmp/db.sqlite", 'QUOTED="hello world"', "SINGLE='x'"].join("\n"))).toEqual({
      DATABASE_URL: "file:/tmp/db.sqlite",
      QUOTED: "hello world",
      SINGLE: "x",
    });
  });

  it(".env.local overrides values loaded from .env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-env-test-"));
    try {
      delete process.env.DATABASE_URL;
      await writeFile(path.join(root, ".env"), "DATABASE_URL=file:/tmp/from-env.db\n");
      await writeFile(path.join(root, ".env.local"), "DATABASE_URL=file:/tmp/from-env-local.db\n");

      const loaded = loadPlantLabEnvFiles(root);

      expect(loaded.keys).toContain("DATABASE_URL");
      expect(process.env.DATABASE_URL).toBe("file:/tmp/from-env-local.db");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not override an explicit process environment value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-env-test-"));
    try {
      process.env.DATABASE_URL = "file:/tmp/explicit.db";
      await writeFile(path.join(root, ".env"), "DATABASE_URL=file:/tmp/from-env.db\n");
      await writeFile(path.join(root, ".env.local"), "DATABASE_URL=file:/tmp/from-env-local.db\n");

      loadPlantLabEnvFiles(root);

      expect(process.env.DATABASE_URL).toBe("file:/tmp/explicit.db");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
