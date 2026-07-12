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
 *   npm run data:doctor -- --remove-stale-ingest-files
 *                                                  - also delete stale
 *                                                    leftover .partial
 *                                                    ingest staging files
 *                                                    (see ingest.server.ts)
 *                                                    older than one hour
 */
import {
  auditProjectDirectories,
  auditStaleIngestFiles,
  DEFAULT_MIN_ORPHAN_AGE_MS,
  DEFAULT_STALE_INGEST_AGE_MS,
  formatBytes,
  removeEmptyOrphans,
  removeStaleIngestFiles,
} from "../src/lib/dataDoctor.server";
import { prisma } from "../src/lib/prisma";

function parseFlags(argv: string[]) {
  const remove = argv.includes("--remove-empty-orphans");
  const removeStaleIngest = argv.includes("--remove-stale-ingest-files");
  const ignoreAge = argv.includes("--ignore-age");
  const minAgeArg = argv.find((a) => a.startsWith("--min-age-ms="));
  const minAgeMs = minAgeArg ? Number(minAgeArg.slice("--min-age-ms=".length)) : undefined;
  return { remove, removeStaleIngest, ignoreAge, minAgeMs };
}

async function main() {
  const { remove, removeStaleIngest, ignoreAge, minAgeMs } = parseFlags(process.argv.slice(2));

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
  } else {
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

  console.log("\n---\n");

  const ingestReport = await auditStaleIngestFiles({ minAgeMs });
  console.log(`Ingest staging directory: ${ingestReport.ingestDir}`);
  console.log(
    `Stale .partial ingest files (age >= ${Math.round((minAgeMs ?? DEFAULT_STALE_INGEST_AGE_MS) / 60000)} min): ${ingestReport.staleFiles.length} (${formatBytes(ingestReport.totalStaleBytes)})`,
  );
  for (const file of ingestReport.staleFiles) {
    console.log(`  ${file.filePath} (${formatBytes(file.byteSize)}, mtime ${file.mtime.toISOString()})`);
  }
  if (ingestReport.recentFiles.length > 0) {
    console.log(`Recent .partial ingest files (likely an in-flight upload, never touched): ${ingestReport.recentFiles.length}`);
  }
  if (ingestReport.unexpectedEntries.length > 0) {
    console.log(`Unexpected entries under the ingest directory (never touched by cleanup): ${ingestReport.unexpectedEntries.length}`);
    for (const entry of ingestReport.unexpectedEntries) {
      console.log(`  ${entry}`);
    }
  }

  if (!removeStaleIngest) {
    console.log(
      ingestReport.staleFiles.length > 0
        ? `Dry run only - nothing was deleted. Re-run with --remove-stale-ingest-files to remove the ${ingestReport.staleFiles.length} stale file(s) listed above.`
        : "Dry run only - nothing to remove.",
    );
    return;
  }

  const ingestResult = await removeStaleIngestFiles(ingestReport, { ignoreAge });
  console.log(`Removed ${ingestResult.removed.length} stale ingest file(s):`);
  for (const removedPath of ingestResult.removed) {
    console.log(`  ${removedPath}`);
  }
  if (ingestResult.skipped.length > 0) {
    console.log(`\nSkipped ${ingestResult.skipped.length}:`);
    for (const skip of ingestResult.skipped) {
      console.log(`  ${skip.filePath}: ${skip.reason}`);
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
