import type { Command } from "commander";
import { formatBytes, runDoctorReport, runStorageAudit, applyStorageRemediation } from "../../lib/operations/doctor";
import { prisma } from "../../lib/prisma";
import { printDoctorReport } from "../format";

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command("doctor")
    .description("Structured health report: database, storage, camera, capture service, node status, backups")
    .option("--capture [device]", "Also capture one real temporary frame to verify the hardware path (not saved)")
    .action(async (options: { capture?: string | boolean }) => {
      try {
        const captureRequested = options.capture !== undefined;
        const captureDevice = typeof options.capture === "string" ? options.capture : null;

        const report = await runDoctorReport({ captureRequested, captureDevice });
        printDoctorReport(report);

        if (!report.summary.ok) {
          process.exitCode = 1;
        }
      } finally {
        await prisma.$disconnect();
      }
    });

  doctor
    .command("storage")
    .description("Detailed project-directory and ingest-staging audit, with optional remediation")
    .option("--remove-empty-orphans", "Delete qualifying empty orphan project directories (never non-empty, never symlinks)")
    .option("--remove-stale-ingest-files", "Delete stale leftover .partial ingest staging files")
    .option("--ignore-age", "Skip the safety-interval age check (explicit override only)")
    .option("--min-age-ms <ms>", "Override the default safety-interval age threshold", (v) => Number(v))
    .action(
      async (options: {
        removeEmptyOrphans?: boolean;
        removeStaleIngestFiles?: boolean;
        ignoreAge?: boolean;
        minAgeMs?: number;
      }) => {
        try {
          const report = await runStorageAudit({ minAgeMs: options.minAgeMs });
          const { projectDirectories, ingestFiles } = report;

          console.log(`Data root: ${projectDirectories.dataRoot}`);
          console.log(`Projects data directory: ${projectDirectories.projectsDataDir}`);
          console.log(`Database projects: ${projectDirectories.totalDbProjects}`);
          console.log(`Existing directories on disk: ${projectDirectories.existingDirectoryNames.length}`);
          console.log("");

          if (projectDirectories.missingExpectedDirectories.length > 0) {
            console.log(
              `Projects with no directory on disk yet (${projectDirectories.missingExpectedDirectories.length}) - normal until their first capture/upload:`,
            );
            for (const missing of projectDirectories.missingExpectedDirectories) {
              console.log(`  ${missing.projectId} -> ${missing.directoryPath}`);
            }
            console.log("");
          }

          console.log(`Empty orphan directories: ${projectDirectories.emptyOrphans.length}`);
          for (const orphan of projectDirectories.emptyOrphans) {
            console.log(`  ${orphan.directoryPath} (mtime ${orphan.mtime.toISOString()})`);
          }
          console.log("");

          if (projectDirectories.nonEmptyOrphans.length > 0) {
            console.log(`NON-EMPTY orphan directories (${projectDirectories.nonEmptyOrphans.length}) - never auto-deleted, inspect manually:`);
            for (const orphan of projectDirectories.nonEmptyOrphans) {
              console.log(`  ${orphan.directoryPath} - files: ${orphan.fileCount}, size: ${formatBytes(orphan.totalBytes)}, mtime: ${orphan.mtime.toISOString()}`);
            }
            console.log("");
          }

          if (projectDirectories.malformedNames.length > 0) {
            console.log(`Malformed/unexpected directory names (${projectDirectories.malformedNames.length}):`);
            for (const entry of projectDirectories.malformedNames) {
              console.log(`  ${entry.directoryPath}`);
            }
            console.log("");
          }

          if (projectDirectories.symlinks.length > 0) {
            console.log(`Symlinks under the projects data directory (${projectDirectories.symlinks.length}) - always preserved:`);
            for (const entry of projectDirectories.symlinks) {
              console.log(`  ${entry.directoryPath}`);
            }
            console.log("");
          }

          console.log("---");
          console.log(`Ingest staging directory: ${ingestFiles.ingestDir}`);
          console.log(`Stale .partial ingest files: ${ingestFiles.staleFiles.length} (${formatBytes(ingestFiles.totalStaleBytes)})`);
          for (const file of ingestFiles.staleFiles) {
            console.log(`  ${file.filePath} (${formatBytes(file.byteSize)}, mtime ${file.mtime.toISOString()})`);
          }
          if (ingestFiles.recentFiles.length > 0) {
            console.log(`Recent .partial ingest files (likely in-flight, never touched): ${ingestFiles.recentFiles.length}`);
          }
          console.log("");

          if (!options.removeEmptyOrphans && !options.removeStaleIngestFiles) {
            console.log(
              "Dry run only - nothing was deleted. Re-run with --remove-empty-orphans and/or --remove-stale-ingest-files to clean up qualifying items.",
            );
            return;
          }

          const remediation = await applyStorageRemediation(report, {
            removeEmptyOrphans: options.removeEmptyOrphans,
            removeStaleIngestFiles: options.removeStaleIngestFiles,
            ignoreAge: options.ignoreAge,
            minAgeMs: options.minAgeMs,
          });

          if (remediation.emptyOrphans) {
            console.log(`Removed ${remediation.emptyOrphans.removed.length} empty orphan director${remediation.emptyOrphans.removed.length === 1 ? "y" : "ies"}.`);
            for (const skip of remediation.emptyOrphans.skipped) {
              console.log(`  skipped ${skip.directoryPath}: ${skip.reason}`);
            }
          }
          if (remediation.staleIngestFiles) {
            console.log(`Removed ${remediation.staleIngestFiles.removed.length} stale ingest file(s).`);
            for (const skip of remediation.staleIngestFiles.skipped) {
              console.log(`  skipped ${skip.filePath}: ${skip.reason}`);
            }
          }
        } finally {
          await prisma.$disconnect();
        }
      },
    );
}
