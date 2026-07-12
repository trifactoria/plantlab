import type { Command } from "commander";
import packageJson from "../../../package.json";

export function registerVersionCommand(program: Command): void {
  program
    .command("version")
    .description("Print the PlantLab CLI/application version")
    .action(() => {
      console.log(`plantlab ${packageJson.version}`);
    });
}
