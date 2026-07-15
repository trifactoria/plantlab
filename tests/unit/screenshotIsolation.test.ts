import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFixtureDatabase } from "../helpers/devData";
import { buildFixtureScreenshotEnv } from "../../src/lib/operations/supportCollect";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// assertFixtureDatabase() reads process.env directly. Snapshot and restore
// only the keys these cases touch so the rest of the run keeps its own
// isolated DATABASE_URL/PLANTLAB_ROOT_DIR (set by tests/unit/setup).
const TOUCHED = ["DATABASE_URL", "PLANTLAB_ROOT_DIR", "VITEST", "PLANTLAB_SCREENSHOTS_FIXTURE_ONLY"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof TOUCHED)[number], string | undefined>>) {
  for (const key of TOUCHED) {
    if (!(key in saved)) saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of TOUCHED) {
    if (key in saved) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  for (const key of Object.keys(saved)) delete saved[key];
});

describe("mutating screenshot fixture refuses to run against a live-looking database", () => {
  it("throws when DATABASE_URL points at the live coordinator dev.db (relative form)", () => {
    setEnv({ VITEST: undefined, PLANTLAB_SCREENSHOTS_FIXTURE_ONLY: "1", DATABASE_URL: "file:./dev.db", PLANTLAB_ROOT_DIR: "/home/andy/projects/plantlab" });
    expect(() => assertFixtureDatabase()).toThrow(/Refusing to seed or clean/i);
  });

  it("throws when DATABASE_URL is the live coordinator dev.db absolute path even with the fixture flag set", () => {
    setEnv({
      VITEST: undefined,
      PLANTLAB_SCREENSHOTS_FIXTURE_ONLY: "1",
      DATABASE_URL: "file:/home/andy/projects/plantlab/prisma/dev.db",
      PLANTLAB_ROOT_DIR: "/home/andy/projects/plantlab",
    });
    expect(() => assertFixtureDatabase()).toThrow(/Refusing to seed or clean/i);
  });

  it("throws when neither the vitest nor the screenshot-fixture flag is set", () => {
    setEnv({ VITEST: undefined, PLANTLAB_SCREENSHOTS_FIXTURE_ONLY: undefined, DATABASE_URL: "file:/tmp/plantlab-test-x/dev.db", PLANTLAB_ROOT_DIR: "/tmp/plantlab-test-x" });
    expect(() => assertFixtureDatabase()).toThrow(/Refusing to seed or clean/i);
  });

  it("passes for an isolated screenshot-fixture database under a temp fixture root", () => {
    setEnv({
      VITEST: undefined,
      PLANTLAB_SCREENSHOTS_FIXTURE_ONLY: "1",
      DATABASE_URL: "file:/tmp/plantlab-screenshots-fixture-abc/prisma/plantlab-test-playwright.db",
      PLANTLAB_ROOT_DIR: "/tmp/plantlab-screenshots-fixture-abc",
    });
    expect(() => assertFixtureDatabase()).not.toThrow();
  });

  it("passes under vitest against a plantlab-test isolated database (the current run itself)", () => {
    // Restore the real vitest env for this assertion.
    expect(process.env.VITEST).toBe("true");
    expect(process.env.DATABASE_URL ?? "").toMatch(/plantlab-test/);
    expect(() => assertFixtureDatabase()).not.toThrow();
  });
});

describe("live-readonly screenshot spec loads no fixture seed/cleanup helpers", () => {
  const specPath = path.join(REPO_ROOT, "tests", "live-readonly-screenshots.spec.ts");
  const source = readFileSync(specPath, "utf8");

  it("does not import the mutating fixture helpers module", () => {
    expect(source).not.toMatch(/helpers\/devData/);
  });

  it("references no seed or cleanup fixture helpers by name", () => {
    for (const symbol of ["seedVisualData", "seedNodeVisualData", "cleanupVisualData", "cleanupNodeVisualData"]) {
      expect(source.includes(symbol)).toBe(false);
    }
  });

  it("guards itself to the live-readonly mode and refuses fixture mode", () => {
    expect(source).toMatch(/PLANTLAB_SCREENSHOTS_LIVE_READONLY/);
  });

  it("the mutating fixture spec conversely refuses to run in live-readonly mode", () => {
    const fixtureSpec = readFileSync(path.join(REPO_ROOT, "tests", "screenshots.spec.ts"), "utf8");
    expect(fixtureSpec).toMatch(/PLANTLAB_SCREENSHOTS_LIVE_READONLY[^]*throw new Error/);
  });
});

describe("fixture screenshot mode uses a temporary absolute SQLite database", () => {
  it("builds a file: DATABASE_URL at an absolute temp path, never the live coordinator DB", () => {
    const fixtureRoot = "/tmp/plantlab-screenshots-fixture-xyz";
    const { fixtureDb, env } = buildFixtureScreenshotEnv(fixtureRoot, 41234);

    expect(path.isAbsolute(fixtureDb)).toBe(true);
    expect(fixtureDb.startsWith(fixtureRoot)).toBe(true);
    expect(fixtureDb).toMatch(/plantlab-test-playwright\.db$/);

    expect(env.DATABASE_URL).toBe(`file:${fixtureDb}`);
    expect(env.DATABASE_URL).not.toMatch(/file:\.\/dev\.db/);
    expect(env.DATABASE_URL).not.toMatch(/\/home\/andy\/projects\/plantlab\/prisma\/dev\.db/);
    expect(env.PLANTLAB_ROOT_DIR).toBe(fixtureRoot);
    expect(env.PLANTLAB_SCREENSHOTS_FIXTURE_ONLY).toBe("1");
    expect(env.PLAYWRIGHT_REUSE_EXISTING_SERVER).toBe("0");

    // And the resulting env still satisfies the runtime isolation guard.
    const previous = { url: process.env.DATABASE_URL, root: process.env.PLANTLAB_ROOT_DIR, vitest: process.env.VITEST };
    try {
      process.env.DATABASE_URL = env.DATABASE_URL;
      process.env.PLANTLAB_ROOT_DIR = env.PLANTLAB_ROOT_DIR;
      delete process.env.VITEST;
      process.env.PLANTLAB_SCREENSHOTS_FIXTURE_ONLY = "1";
      expect(() => assertFixtureDatabase()).not.toThrow();
    } finally {
      process.env.DATABASE_URL = previous.url;
      process.env.PLANTLAB_ROOT_DIR = previous.root;
      if (previous.vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous.vitest;
    }
  });

  it("rejects a relative fixture root", () => {
    expect(() => buildFixtureScreenshotEnv("relative/path", 3000)).toThrow(/absolute/i);
  });
});
