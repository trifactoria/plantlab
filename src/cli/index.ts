import "../lib/suppressExpectedWarnings";
import { Command } from "commander";
import packageJson from "../../package.json";
import { loadPlantLabEnvFiles } from "../lib/envFiles.server";

loadPlantLabEnvFiles();

/**
 * The canonical PlantLab operational interface. Every command here is a
 * thin wrapper around shared logic in src/lib/ (mostly src/lib/operations/)
 * - see ARCHITECTURE.md "PlantLab CLI". Existing `pnpm <script>` commands
 * remain as compatibility wrappers that call into this same CLI rather than
 * duplicating any of it.
 */
export async function buildProgram(): Promise<Command> {
  const [
    { registerBackupCommand },
    { registerCameraCommand },
    { registerCaptureCommand },
    { registerDoctorCommand },
    { registerInstallCommand },
    { registerNodeCommand },
    { registerProjectCommand },
    { registerServiceCommand },
    { registerSupportCommand },
    { registerUpdateCommand },
    { registerVersionCommand },
  ] = await Promise.all([
    import("./commands/backup"),
    import("./commands/camera"),
    import("./commands/capture"),
    import("./commands/doctor"),
    import("./commands/install"),
    import("./commands/node"),
    import("./commands/project"),
    import("./commands/service"),
    import("./commands/support"),
    import("./commands/update"),
    import("./commands/version"),
  ]);
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
  registerSupportCommand(program);

  return program;
}

async function main() {
  const program = await buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
