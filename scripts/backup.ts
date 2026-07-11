import { createBackup, listBackups } from "../src/lib/backup";

async function main() {
  const command = process.argv[2] ?? "create";

  if (command === "list") {
    const backups = await listBackups();
    if (backups.length === 0) {
      console.log("No backups found.");
      return;
    }
    for (const backup of backups) {
      console.log(backup);
    }
    return;
  }

  const backup = await createBackup();
  console.log(`Backup created: ${backup.archivePath}`);
  console.log(`Size: ${backup.sizeBytes} bytes`);
  console.log("Manual restore precaution: stop PlantLab/capture services before replacing the database or data directories.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
