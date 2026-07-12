import type { Command } from "commander";
import { runUpdate } from "../../lib/operations/update";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Bring this machine's code, schema, and services up to date for its configured role")
    .option("--skip-install", "Do not run pnpm install")
    .option("--skip-build", "Do not run the production build (coordinator/standalone only)")
    .option("--no-restart", "Update code/schema without restarting services")
    .addHelpText(
      "after",
      `

Idempotent and role-aware - a camera-node update never touches the
canonical domain database or starts web/camera services. Does not run
"git pull" - pull first, then update:

Examples:
  git pull && plantlab update
  plantlab update --skip-build
  plantlab update --no-restart
`,
    )
    .action(async (options: { skipInstall?: boolean; skipBuild?: boolean; restart?: boolean }) => {
      const result = await runUpdate({
        skipInstall: options.skipInstall,
        skipBuild: options.skipBuild,
        restartServices: options.restart !== false,
      });

      for (const step of result.steps) {
        console.log(`[${step.ok ? "OK" : "FAIL"}] ${step.name}: ${step.detail}`);
      }

      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
