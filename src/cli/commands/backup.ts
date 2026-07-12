import type { Command } from "commander";
import { createBackup, listBackupsWithMetadata, restoreBackup, verifyBackup } from "../../lib/backup";
import { formatBytes } from "../../lib/operations/doctor";

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description("Create, list, verify, and (safely) restore PlantLab backups")
    .addHelpText(
      "after",
      `

Examples:
  plantlab backup list
  plantlab backup create
  plantlab backup verify backups/plantlab-2026-07-12.tar.gz
`,
    );

  backup
    .command("create")
    .description("Create a new backup archive of the database and project data")
    .action(async () => {
      const result = await createBackup();
      console.log(`Backup created: ${result.archivePath}`);
      console.log(`Manifest:       ${result.manifestPath}`);
      console.log(`Size:           ${formatBytes(result.sizeBytes)}`);
      console.log(`Destination:    ${result.destination.name} (${result.destination.location})`);
      console.log("Manual restore precaution: stop PlantLab/capture services before replacing the database or data directories.");
    });

  backup
    .command("list")
    .description("List backups, newest last, with metadata when available")
    .action(async () => {
      const backups = await listBackupsWithMetadata();
      if (backups.length === 0) {
        console.log("No backups found.");
        return;
      }

      for (const entry of backups) {
        console.log(entry.archivePath);
        console.log(`  size: ${formatBytes(entry.sizeBytes)}, modified: ${entry.mtime.toISOString()}`);
        if (entry.manifest) {
          console.log(`  format: ${entry.manifest.format ?? "v1 (legacy)"}, plantlab version: ${entry.manifest.plantlabVersion ?? "unknown"}`);
          if (entry.manifest.projectLifecycleSnapshot) {
            console.log(`  projects at backup time: ${entry.manifest.projectLifecycleSnapshot.length}`);
          }
        } else {
          console.log("  (no sidecar manifest - legacy backup, structural verification only)");
        }
      }
    });

  backup
    .command("verify")
    .description("Verify a backup archive's structural integrity and (if available) its checksum")
    .argument("<archivePath>")
    .action(async (archivePath: string) => {
      const result = await verifyBackup(archivePath);
      console.log(`${result.archivePath}${result.legacy ? " (legacy - no checksum manifest)" : ""}`);
      for (const check of result.checks) {
        console.log(`  [${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
      }
      console.log(result.ok ? "Verification passed." : "Verification FAILED.");
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  backup
    .command("restore")
    .description("Extract a backup archive into a staging directory for manual inspection/restore (never overwrites live data automatically)")
    .argument("<archivePath>")
    .requiredOption("--to <directory>", "Staging directory to extract into (must not be the live PlantLab root)")
    .option("--force", "Extract even if verification fails")
    .action(async (archivePath: string, options: { to: string; force?: boolean }) => {
      try {
        const result = await restoreBackup(archivePath, options.to, { force: options.force });
        console.log(`Extracted to: ${result.extractedTo}`);
        console.log(`Verification: ${result.verified.ok ? "passed" : "FAILED (extracted anyway due to --force)"}`);
        console.log("");
        console.log("Next steps:");
        for (const step of result.nextSteps) {
          console.log(`  - ${step}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
