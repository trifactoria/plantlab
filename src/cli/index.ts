import { Command } from "commander";
import packageJson from "../../package.json";
import { registerBackupCommand } from "./commands/backup";
import { registerCameraCommand } from "./commands/camera";
import { registerCaptureCommand } from "./commands/capture";
import { registerDoctorCommand } from "./commands/doctor";
import { registerInstallCommand } from "./commands/install";
import { registerNodeCommand } from "./commands/node";
import { registerProjectCommand } from "./commands/project";
import { registerServiceCommand } from "./commands/service";
import { registerUpdateCommand } from "./commands/update";
import { registerVersionCommand } from "./commands/version";

/**
 * The canonical PlantLab operational interface. Every command here is a
 * thin wrapper around shared logic in src/lib/ (mostly src/lib/operations/)
 * - see ARCHITECTURE.md "PlantLab CLI". Existing `pnpm <script>` commands
 * remain as compatibility wrappers that call into this same CLI rather than
 * duplicating any of it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("plantlab")
    .description("PlantLab operational CLI")
    .version(packageJson.version)
    .showHelpAfterError()
    .addHelpText(
      "after",
      `

Examples:
  plantlab doctor
  plantlab camera list
  plantlab node inspect xps
  plantlab backup list
  plantlab install
`,
    );

  registerVersionCommand(program);
  registerDoctorCommand(program);
  registerInstallCommand(program);
  registerUpdateCommand(program);
  registerServiceCommand(program);
  registerNodeCommand(program);
  registerCameraCommand(program);
  registerCaptureCommand(program);
  registerBackupCommand(program);
  registerProjectCommand(program);

  return program;
}

async function main() {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
