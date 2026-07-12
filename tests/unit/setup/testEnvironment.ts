/**
 * Vitest `setupFiles` entry - imported and fully awaited (top-level await)
 * before each test file's own module graph runs, so `PLANTLAB_ROOT_DIR`
 * and `DATABASE_URL` are already pointed at an isolated, disposable
 * environment before that file's `import { prisma } from "@/lib/prisma"`
 * (or any path resolver) ever executes. A `beforeAll`/`afterAll` hook
 * would run too late for this - hooks fire after the whole module graph
 * has already been imported.
 *
 * Layout (see DEPLOYMENT.md "Test isolation" for the full design):
 *
 *   <temp-root>/
 *     database/plantlab-test.db   <- DATABASE_URL
 *     data/
 *       projects/
 *       capture-sources/
 *       ingest/
 *       runtime/locks/
 *     backups/
 *
 * `data/*` matches the real repository's PLANTLAB_ROOT_DIR-relative layout
 * exactly (see src/lib/paths.server.ts), so every existing resolver
 * function works unmodified against this isolated root - no test-only
 * branch was added to the resolvers themselves.
 *
 * A fresh root is created per test FILE (not shared across a whole
 * worker), which is a strictly stronger isolation guarantee than "one per
 * worker" and avoids any ordering dependency between files sharing a
 * worker process. The expensive part (creating the SQLite schema) is
 * hoisted to globalSetup.ts, which runs once for the whole run; each
 * file's setup here is just a handful of mkdir calls plus one file copy.
 */
import { readFileSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { TEMPLATE_MARKER_PATH } from "./globalSetup";

const { templateDbPath } = JSON.parse(readFileSync(TEMPLATE_MARKER_PATH, "utf8")) as {
  templateDbPath: string;
};

const isolatedRoot = path.join(os.tmpdir(), `plantlab-test-${process.pid}-${randomUUID()}`);
const databaseDir = path.join(isolatedRoot, "database");
const databasePath = path.join(databaseDir, "plantlab-test.db");

await mkdir(databaseDir, { recursive: true });
await mkdir(path.join(isolatedRoot, "data", "projects"), { recursive: true });
await mkdir(path.join(isolatedRoot, "data", "capture-sources"), { recursive: true });
await mkdir(path.join(isolatedRoot, "data", "ingest"), { recursive: true });
await mkdir(path.join(isolatedRoot, "data", "runtime", "locks"), { recursive: true });
await mkdir(path.join(isolatedRoot, "backups"), { recursive: true });
await copyFile(templateDbPath, databasePath);

process.env.PLANTLAB_ROOT_DIR = isolatedRoot;
process.env.DATABASE_URL = `file:${databasePath}`;
process.env.PLANTLAB_INGEST_DIR = path.join(isolatedRoot, "data", "ingest");
process.env.PLANTLAB_BACKUP_DIR = path.join(isolatedRoot, "backups");

afterAll(async () => {
  await rm(isolatedRoot, { recursive: true, force: true }).catch(() => undefined);
});
