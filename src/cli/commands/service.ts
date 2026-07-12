import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { validateSshHost } from "../../lib/operations/remoteNode";

const UNITS = ["plantlab-web.service", "plantlab-camera.service", "plantlab-agent.service"];

function runSystemctl(action: string, node?: string): number {
  let result;
  if (node) {
    try {
      validateSshHost(node);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    result = spawnSync("ssh", [node, "systemctl", "--user", action, ...UNITS], { stdio: "inherit" });
  } else {
    result = spawnSync("systemctl", ["--user", action, ...UNITS], { stdio: "inherit" });
  }

  if (result.error) {
    console.error(`Could not run systemctl: ${result.error.message}`);
    console.error('Is systemd installed and are the units set up? Run "plantlab install" first.');
    return 1;
  }

  return result.status ?? 1;
}

export function registerServiceCommand(program: Command): void {
  const service = program.command("service").description("Manage PlantLab systemd user services");

  service
    .command("status")
    .description("Show systemd status for PlantLab services")
    .option("--node <ssh-host>", "Run the status command over SSH on a configured node")
    .action((options: { node?: string }) => {
      process.exitCode = runSystemctl("status", options.node);
    });

  service
    .command("start")
    .description("Start PlantLab services")
    .option("--node <ssh-host>", "Run the start command over SSH on a configured node")
    .action((options: { node?: string }) => {
      process.exitCode = runSystemctl("start", options.node);
    });

  service
    .command("stop")
    .description("Stop PlantLab services")
    .option("--node <ssh-host>", "Run the stop command over SSH on a configured node")
    .action((options: { node?: string }) => {
      process.exitCode = runSystemctl("stop", options.node);
    });

  service
    .command("restart")
    .description("Restart PlantLab services")
    .option("--node <ssh-host>", "Run the restart command over SSH on a configured node")
    .action((options: { node?: string }) => {
      process.exitCode = runSystemctl("restart", options.node);
    });
}
