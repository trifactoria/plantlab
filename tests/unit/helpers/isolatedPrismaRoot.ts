import { mkdir, mkdtemp, rm, symlink, copyFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * migrations.ts genuinely needs a real prisma/schema.prisma,
 * prisma/migrations/, and node_modules/.bin/prisma to do anything - the
 * standard per-test-file isolated root (tests/unit/setup/testEnvironment.ts)
 * deliberately does NOT include any of that (it only needs a database
 * file). This builds a second, throwaway root specifically for
 * migrations.ts tests: a real schema/migrations (copied, read-only usage)
 * plus a symlinked node_modules (too large to copy) plus empty
 * data/projects and backups directories so createBackup() has something
 * valid to archive - all under a temp directory, never the real repo's
 * database.
 */
export async function createIsolatedPrismaRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const realRepoRoot = path.resolve(__dirname, "..", "..", "..");
  // Prefix must contain "plantlab-test" - src/lib/prisma.ts refuses to
  // construct a PrismaClient under Vitest unless DATABASE_URL matches that
  // pattern, as defense in depth against a test ever touching the real
  // development database. See tests/unit/setup/testEnvironment.ts.
  const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-test-migrations-"));

  await symlink(path.join(realRepoRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  await mkdir(path.join(root, "prisma"), { recursive: true });
  await copyFile(path.join(realRepoRoot, "prisma", "schema.prisma"), path.join(root, "prisma", "schema.prisma"));
  await cp(path.join(realRepoRoot, "prisma", "migrations"), path.join(root, "prisma", "migrations"), { recursive: true });
  await mkdir(path.join(root, "data", "projects"), { recursive: true });
  await mkdir(path.join(root, "backups"), { recursive: true });

  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
