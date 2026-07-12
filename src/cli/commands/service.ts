import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { readNodeConfig } from "../../lib/operations/config";
import { inspectRemoteHost, validateSshHost } from "../../lib/operations/remoteNode";
import { serviceUnitsForSelection } from "../../lib/operations/serviceRoles";

async function runSystemctl(action: string, options: { node?: string; service?: string; all?: boolean }): Promise<number> {
  let result;
  let role: string | null = null;
  if (options.node) {
    try {
      validateSshHost(options.node);
      if (!options.all && !options.service) {
        role = (await inspectRemoteHost(options.node)).role;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const units = serviceUnitsForSelection({ role, service: options.service, all: options.all });
    result = spawnSync("ssh", [options.node, "systemctl", "--user", action, ...units], { stdio: "inherit" });
  } else {
    if (!options.all && !options.service) {
      role = (await readNodeConfig())?.role ?? null;
    }
    const units = serviceUnitsForSelection({ role, service: options.service, all: options.all });
    result = spawnSync("systemctl", ["--user", action, ...units], { stdio: "inherit" });
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

  function addServiceOptions(command: Command) {
    return command
      .option("--node <ssh-host>", "Run the command over SSH on a configured node")
      .option("--service <service>", "Manage one service: web, camera, or agent")
      .option("--all", "Manage all PlantLab services instead of the services expected for this node role");
  }

  service
    .command("status")
    .description("Show systemd status for PlantLab services")
    .addHelpText("after", "\nExamples:\n  plantlab service status\n  plantlab service status --node xps\n  plantlab service status --all\n")
    .configureHelp({ showGlobalOptions: true });

  addServiceOptions(service.commands.find((command) => command.name() === "status")!)
    .action(async (options: { node?: string; service?: string; all?: boolean }) => {
      process.exitCode = await runSystemctl("status", options);
    });

  addServiceOptions(service.command("start")
    .description("Start PlantLab services")
    .addHelpText("after", "\nExamples:\n  plantlab service start\n  plantlab service start --node xps\n  plantlab service start --service agent\n  plantlab service start --all\n"))
    .action(async (options: { node?: string; service?: string; all?: boolean }) => {
      process.exitCode = await runSystemctl("start", options);
    });

  addServiceOptions(service.command("stop")
    .description("Stop PlantLab services")
    .addHelpText("after", "\nExamples:\n  plantlab service stop\n  plantlab service stop --node xps\n  plantlab service stop --service web\n  plantlab service stop --all\n"))
    .action(async (options: { node?: string; service?: string; all?: boolean }) => {
      process.exitCode = await runSystemctl("stop", options);
    });

  addServiceOptions(service.command("restart")
    .description("Restart PlantLab services")
    .addHelpText("after", "\nExamples:\n  plantlab service restart\n  plantlab service restart --node xps\n  plantlab service restart --service agent\n  plantlab service restart --all\n"))
    .action(async (options: { node?: string; service?: string; all?: boolean }) => {
      process.exitCode = await runSystemctl("restart", options);
    });
}
