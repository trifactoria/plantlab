import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { NODE_ROLES, isValidNodeRole, type NodeRole } from "../../lib/operations/config";
import { runInstall } from "../../lib/operations/install";

const ROLE_DESCRIPTIONS: Record<NodeRole, string> = {
  coordinator: "Runs the web app and owns the canonical database - the machine other nodes report to.",
  "camera-node": "Runs scheduled capture for one or more attached cameras and reports to a coordinator.",
  standalone: "A single machine running the full app with no other nodes (today's default deployment shape).",
  "microscope-node": "A future specialized capture node for microscope imaging.",
  "mobile-uploader": "A future mobile client that uploads captures via the HTTP ingest endpoint.",
  "greenhouse-node": "A camera-capable node that will later advertise sensor/relay capabilities as they are implemented - camera-only for now.",
};

async function promptForRole(): Promise<NodeRole> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Select this machine's role:");
    NODE_ROLES.forEach((role, index) => {
      console.log(`  ${index + 1}) ${role} - ${ROLE_DESCRIPTIONS[role]}`);
    });

    for (;;) {
      const answer = (await rl.question(`Role [1-${NODE_ROLES.length}]: `)).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < NODE_ROLES.length) {
        return NODE_ROLES[index];
      }
      console.log(`Enter a number between 1 and ${NODE_ROLES.length}.`);
    }
  } finally {
    rl.close();
  }
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description("Interactive setup: choose this node's role, validate dependencies, prepare directories, generate systemd units")
    .option("--role <role>", `One of: ${NODE_ROLES.join(", ")}`)
    .option("--coordinator-url <url>", "Coordinator URL for a camera-node/microscope-node/mobile-uploader role (registration itself is still manual)")
    .option("--skip-systemd", "Do not generate systemd units (useful in a dev sandbox)")
    .addHelpText(
      "after",
      `

Examples:
  plantlab install
  plantlab install --role standalone
  plantlab install --role coordinator
  plantlab install --role camera-node --coordinator-url http://plantlab:3000
`,
    )
    .action(async (options: { role?: string; coordinatorUrl?: string; skipSystemd?: boolean }) => {
      let role: NodeRole;
      if (options.role) {
        if (!isValidNodeRole(options.role)) {
          console.error(`Invalid --role "${options.role}". Valid values: ${NODE_ROLES.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        role = options.role;
      } else if (process.stdin.isTTY) {
        role = await promptForRole();
      } else {
        console.error(`No TTY available for an interactive prompt - pass --role explicitly. Valid values: ${NODE_ROLES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      console.log(`\nInstalling PlantLab as role "${role}"...\n`);
      const result = await runInstall({ role, coordinatorUrl: options.coordinatorUrl ?? null, skipSystemd: options.skipSystemd });

      console.log("");
      for (const step of result.steps) {
        console.log(`  [${step.ok ? "OK" : "FAIL"}] ${step.name}: ${step.detail}`);
      }
      console.log("");
      console.log(`Node configuration written to: ${result.configPath}`);
      console.log('Run "plantlab doctor" to confirm everything is healthy.');

      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
