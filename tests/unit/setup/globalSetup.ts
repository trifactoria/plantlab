/**
 * Vitest `globalSetup` - runs exactly once, in the main orchestrating
 * process, before any worker/test file starts. Builds one "template"
 * SQLite database (schema applied via `prisma db push`, no data) that
 * every isolated per-file test environment then cheaply copies rather
 * than re-running `prisma db push` (spawns the Prisma CLI, ~1s+) for each
 * of the ~45 test files. See testEnvironment.ts for the per-file half of
 * this.
 *
 * The template's path is handed to workers via a small marker file at a
 * fixed, well-known temp location (Vitest's `provide`/`inject` only
 * propagates values to files running in the same pool in some versions/
 * pool types; a plain file on disk works identically regardless of pool
 * type - threads, forks, or vmForks).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TEMPLATE_MARKER_PATH = path.join(os.tmpdir(), "plantlab-vitest-template-marker.json");

export async function setup() {
  const templateRoot = await mkdtemp(path.join(os.tmpdir(), "plantlab-test-template-"));
  const templateDbPath = path.join(templateRoot, "plantlab-test-template.db");
  const schemaPath = path.resolve(__dirname, "../../../prisma/schema.prisma");

  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schemaPath], {
    env: { ...process.env, DATABASE_URL: `file:${templateDbPath}` },
    stdio: "pipe",
  });

  await writeFile(TEMPLATE_MARKER_PATH, JSON.stringify({ templateDbPath }), "utf8");

  return async function teardown() {
    await rm(templateRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(TEMPLATE_MARKER_PATH, { force: true }).catch(() => undefined);
  };
}
