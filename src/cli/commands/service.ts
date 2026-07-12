import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { readNodeConfig } from "../../lib/operations/config";
import { checkMigrationStatus } from "../../lib/operations/migrations";
import { prisma } from "../../lib/prisma";
import { inspectRemoteHost, validateSshHost } from "../../lib/operations/remoteNode";
import { expectedServicesForRole, requireExpectedServicesForRole, serviceUnitsForSelection, SERVICE_UNITS } from "../../lib/operations/serviceRoles";

const MUTATING_ACTIONS = new Set(["start", "stop", "restart"]);

/**
 * Part of this task's database migration policy (see DEPLOYMENT.md): a
 * database-dependent service must never start against a stale schema.
 * Applies whenever plantlab-web.service or plantlab-camera.service is
 * among the units being started - both always touch the canonical domain
 * database directly, regardless of which role happened to select them.
 * This only ever checks and reports - it never runs a migration itself
 * (that stays an explicit `plantlab update`), since silently mutating the
 * database as a side effect of "start the service" would be a surprising,
 * risky thing for a thin systemctl wrapper to do.
 */
async function refuseIfSchemaStale(units: string[]): Promise<boolean> {
  if (!units.includes(SERVICE_UNITS.web) && !units.includes(SERVICE_UNITS.camera)) return false;

  const status = await checkMigrationStatus().catch(() => null);
  if (!status || status.current) return false;

  console.error(`Refusing to start: local database schema is not current (${status.detail}).`);
  console.error("Run: plantlab update");
  return true;
}

/**
 * A node with no valid role configuration must never have services
 * started/stopped/restarted on its behalf just because a caller happened
 * to omit --service/--all - see DEPLOYMENT.md "Role-aware service start
 * must use intended state safely". Looks up the coordinator's own
 * PlantLabNode record (if any) so the message reflects real enrollment
 * state instead of just "unknown".
 */
async function printUnknownRoleGuidance(node: string | undefined): Promise<void> {
  console.error("Cannot determine expected services because this node has no valid role configuration.");
  console.error("");

  if (node) {
    const record = await prisma.plantLabNode.findUnique({ where: { name: node }, select: { role: true, status: true } }).catch(() => null);
    console.error(record ? `Detected coordinator enrollment: ${record.role} ${record.status}` : "No coordinator enrollment record found for this node.");
    console.error("");
    console.error("Suggested action:");
    console.error(`plantlab doctor --node ${node} --fix`);
  } else {
    console.error("Suggested action:");
    console.error("plantlab install");
  }
}

async function runSystemctl(action: string, options: { node?: string; service?: string; all?: boolean }): Promise<number> {
  const isMutating = MUTATING_ACTIONS.has(action);
  let role: string | null = null;

  if (options.node) {
    try {
      validateSshHost(options.node);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (!options.all && !options.service) {
      role = (await inspectRemoteHost(options.node)).role;
    }
  } else if (!options.all && !options.service) {
    role = (await readNodeConfig())?.role ?? null;
  }

  let units: string[];
  if (options.all || options.service) {
    // An explicit selection never needs to know the role at all.
    units = serviceUnitsForSelection({ service: options.service, all: options.all });
  } else if (isMutating) {
    // Mutating commands must never guess: an unknown/missing role means no
    // services get started/stopped on this node's behalf.
    try {
      units = requireExpectedServicesForRole(role).map((service) => SERVICE_UNITS[service]);
    } catch {
      await printUnknownRoleGuidance(options.node);
      return 1;
    }
  } else {
    // Read-only status: an unknown role just means "show everything" rather than failing.
    const expected = expectedServicesForRole(role);
    units = (expected.length > 0 ? expected : ["web", "camera", "agent"] as const).map((service) => SERVICE_UNITS[service]);
  }

  if (!options.node && (action === "start" || action === "restart")) {
    if (await refuseIfSchemaStale(units)) {
      return 1;
    }
  }

  const result = options.node
    ? spawnSync("ssh", [options.node, "systemctl", "--user", action, ...units], { stdio: "inherit" })
    : spawnSync("systemctl", ["--user", action, ...units], { stdio: "inherit" });

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
    .description("Start PlantLab services expected for this node's configured role")
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
    .description("Restart PlantLab services expected for this node's configured role")
    .addHelpText("after", "\nExamples:\n  plantlab service restart\n  plantlab service restart --node xps\n  plantlab service restart --service agent\n  plantlab service restart --all\n"))
    .action(async (options: { node?: string; service?: string; all?: boolean }) => {
      process.exitCode = await runSystemctl("restart", options);
    });
}
