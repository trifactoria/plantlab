import type { Command } from "commander";
import { collectSupportBundle, type ScreenshotMode } from "../../lib/operations/supportCollect";

export function registerSupportCommand(program: Command): void {
  const support = program.command("support").description("Collect bounded diagnostics into a local ZIP");

  support
    .command("collect")
    .description("Collect coordinator/node diagnostics and optional screenshots")
    .option("--node <name>", "Collect one node host")
    .option("--coordinator <host>", "Coordinator SSH host", "plantlab")
    .option("--all", "Collect xps, plantlab, greenhouse-zero, and bokchoy")
    .option("--screenshots <mode>", "fixture, live-readonly, or none", "none")
    .option("--output-dir <path>", "Directory for the generated ZIP")
    .action(async (options: { node?: string; coordinator?: string; all?: boolean; screenshots: string; outputDir?: string }) => {
      const screenshots = parseScreenshotMode(options.screenshots);
      const result = await collectSupportBundle({
        node: options.node ?? null,
        coordinator: options.coordinator ?? null,
        all: options.all,
        screenshots,
        outputDir: options.outputDir,
      });
      console.log(result.zipPath);
      const failures = result.manifest.probes.filter((probe) => !probe.ok);
      if (failures.length > 0) {
        console.error(`WARN: ${failures.length} probe(s) failed; see manifest.json inside the ZIP.`);
      }
    });
}

function parseScreenshotMode(value: string): ScreenshotMode {
  if (value === "fixture" || value === "live-readonly" || value === "none") return value;
  throw new Error("--screenshots must be one of: fixture, live-readonly, none");
}
