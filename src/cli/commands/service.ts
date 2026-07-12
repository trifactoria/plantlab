import { spawnSync } from "node:child_process";
import type { Command } from "commander";

const UNITS = ["plantlab-web.service", "plantlab-camera.service"];

function runSystemctl(action: string): number {
  const result = spawnSync("systemctl", ["--user", action, ...UNITS], { stdio: "inherit" });

  if (result.error) {
    console.error(`Could not run systemctl: ${result.error.message}`);
    console.error('Is systemd installed and are the units set up? Run "plantlab install" first.');
    return 1;
  }

  return result.status ?? 1;
}

export function registerServiceCommand(program: Command): void {
  const service = program.command("service").description("Manage the plantlab-web and plantlab-camera systemd user services");

  service
    .command("status")
    .description("Show systemd status for both services")
    .action(() => {
      process.exitCode = runSystemctl("status");
    });

  service
    .command("start")
    .description("Start both services")
    .action(() => {
      process.exitCode = runSystemctl("start");
    });

  service
    .command("stop")
    .description("Stop both services")
    .action(() => {
      process.exitCode = runSystemctl("stop");
    });

  service
    .command("restart")
    .description("Restart both services")
    .action(() => {
      process.exitCode = runSystemctl("restart");
    });
}
