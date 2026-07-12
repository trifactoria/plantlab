/**
 * Compares the canonical SQLite Project table against data/projects/ and
 * reports (never deletes anything by default) empty and non-empty orphan
 * directories, missing expected directories, malformed names, and
 * symlinks.
 *
 * Usage:
 *   npm run data:doctor                          - read-only report
 *   npm run data:doctor -- --remove-empty-orphans - also delete qualifying
 *                                                    empty orphans (never
 *                                                    non-empty ones, never
 *                                                    symlinks)
 *   npm run data:doctor -- --remove-empty-orphans --ignore-age
 *                                                  - also skip the "older
 *                                                    than 1 hour" safety
 *                                                    check (explicit
 *                                                    override only)
 *   npm run data:doctor -- --remove-empty-orphans --min-age-ms=0
 *                                                  - same, via an explicit
 *                                                    threshold instead
 */
import {
  auditProjectDirectories,
  DEFAULT_MIN_ORPHAN_AGE_MS,
  formatBytes,
  removeEmptyOrphans,
} from "../src/lib/dataDoctor.server";
import { prisma } from "../src/lib/prisma";

function parseFlags(argv: string[]) {
  const remove = argv.includes("--remove-empty-orphans");
  const ignoreAge = argv.includes("--ignore-age");
  const minAgeArg = argv.find((a) => a.startsWith("--min-age-ms="));
  const minAgeMs = minAgeArg ? Number(minAgeArg.slice("--min-age-ms=".length)) : undefined;
  return { remove, ignoreAge, minAgeMs };
}

async function main() {
  const { remove, ignoreAge, minAgeMs } = parseFlags(process.argv.slice(2));

  console.log("PlantLab data doctor - project directory audit\n");

  const report = await auditProjectDirectories(prisma);

  console.log(`Data root: ${report.dataRoot}`);
  console.log(`Projects data directory: ${report.projectsDataDir}`);
  console.log(`Database projects: ${report.totalDbProjects}`);
  console.log(`Existing directories on disk: ${report.existingDirectoryNames.length}`);
  console.log("");

  if (report.missingExpectedDirectories.length > 0) {
    console.log(`Projects with no directory on disk yet (${report.missingExpectedDirectories.length}) - normal until their first capture/upload:`);
    for (const missing of report.missingExpectedDirectories) {
      console.log(`  ${missing.projectId} -> ${missing.directoryPath}`);
    }
    console.log("");
  }

  console.log(`Empty orphan directories: ${report.emptyOrphans.length}`);
  for (const orphan of report.emptyOrphans) {
    console.log(`  ${orphan.directoryPath} (mtime ${orphan.mtime.toISOString()})`);
  }
  console.log("");

  if (report.nonEmptyOrphans.length > 0) {
    console.log(`NON-EMPTY orphan directories (${report.nonEmptyOrphans.length}) - never auto-deleted, inspect manually:`);
    for (const orphan of report.nonEmptyOrphans) {
      console.log(
        `  ${orphan.directoryPath}\n` +
          `    files: ${orphan.fileCount}, size: ${formatBytes(orphan.totalBytes)}, mtime: ${orphan.mtime.toISOString()}\n` +
          `    suggested inspection: ls -la "${orphan.directoryPath}" && find "${orphan.directoryPath}" -type f -newer /dev/null`,
      );
    }
    console.log("");
  }

  if (report.malformedNames.length > 0) {
    console.log(`Malformed/unexpected directory names (${report.malformedNames.length}, not a project-id-shaped UUID):`);
    for (const entry of report.malformedNames) {
      console.log(`  ${entry.directoryPath}`);
    }
    console.log("");
  }

  if (report.symlinks.length > 0) {
    console.log(`Symlinks under the projects data directory (${report.symlinks.length}) - always preserved, never touched by cleanup:`);
    for (const entry of report.symlinks) {
      console.log(`  ${entry.directoryPath}`);
    }
    console.log("");
  }

  if (!remove) {
    console.log(
      report.emptyOrphans.length > 0
        ? `Dry run only - nothing was deleted. Re-run with --remove-empty-orphans to remove the ${report.emptyOrphans.length} empty orphan(s) listed above (only those older than ${Math.round((minAgeMs ?? DEFAULT_MIN_ORPHAN_AGE_MS) / 60000)} minutes, unless --ignore-age is also passed).`
        : "Dry run only - nothing to remove.",
    );
    return;
  }

  const result = await removeEmptyOrphans(report, { minAgeMs, ignoreAge });
  console.log(`Removed ${result.removed.length} empty orphan director${result.removed.length === 1 ? "y" : "ies"}:`);
  for (const removedPath of result.removed) {
    console.log(`  ${removedPath}`);
  }
  if (result.skipped.length > 0) {
    console.log(`\nSkipped ${result.skipped.length}:`);
    for (const skip of result.skipped) {
      console.log(`  ${skip.directoryPath}: ${skip.reason}`);
    }
  }
}

main()
  .catch((error) => {
    console.error("data:doctor failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
