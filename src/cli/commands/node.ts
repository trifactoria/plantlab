import os from "node:os";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { readNodeConfig } from "../../lib/operations/config";
import { configureRemoteAgent, defaultCoordinatorUrl, inspectRemoteHost } from "../../lib/operations/remoteNode";
import { registerOrRotateNode } from "../../lib/operations/nodeCredentials";
import { resolveAllPaths } from "../../lib/paths.server";
import { prisma } from "../../lib/prisma";
import { readSshConfigHosts } from "../sshConfig";

async function printLocalNodeInfo(): Promise<void> {
  const config = await readNodeConfig();
  console.log(`hostname: ${os.hostname()}`);

  if (!config) {
    console.log('role: (not configured yet - run "plantlab install")');
    return;
  }

  console.log(`role: ${config.role}`);
  console.log(`configured at: ${config.configuredAt}`);
  if (config.coordinatorUrl) {
    console.log(`coordinator: ${config.coordinatorUrl}`);
  }
}

export function registerNodeCommand(program: Command): void {
  const node = program.command("node").description("Inspect, enroll, and configure PlantLab deployment nodes");

  node
    .command("list")
    .description("List known nodes: this machine, plus any SSH-configured candidates")
    .action(async () => {
      console.log("This node:");
      await printLocalNodeInfo();

      const hosts = await readSshConfigHosts();
      if (hosts.length > 0) {
        console.log("");
        console.log(`SSH-configured candidate machines (${hosts.length}, from ~/.ssh/config - not verified, not registered):`);
        for (const host of hosts) {
          console.log(`  ${host.host}${host.hostName ? ` (${host.hostName})` : ""}${host.user ? ` user=${host.user}` : ""}`);
        }
      }

    });

  node
    .command("info")
    .description("Show this node's configured role and resolved paths")
    .action(async () => {
      await printLocalNodeInfo();
      console.log("");
      console.log("Resolved paths:");
      for (const [key, value] of Object.entries(resolveAllPaths())) {
        console.log(`  ${key}: ${value}`);
      }
    });

  node
    .command("discover")
    .description("List SSH-configured candidate machines that might be other PlantLab nodes")
    .action(async () => {
      const hosts = await readSshConfigHosts();
      if (hosts.length === 0) {
        console.log("No Host entries found in ~/.ssh/config.");
        return;
      }
      console.log(`${hosts.length} candidate(s) from ~/.ssh/config (not verified reachable, not verified to run PlantLab):`);
      for (const host of hosts) {
        console.log(`  ${host.host}${host.hostName ? ` (${host.hostName})` : ""}${host.user ? ` user=${host.user}` : ""}`);
      }
      console.log("");
      console.log('Verify manually, e.g.: ssh <host> "cd <plantlab-repo-path> && plantlab doctor"');
    });

  node
    .command("inspect")
    .description("Inspect a remote host through SSH without changing it")
    .argument("<ssh-host>", "SSH host alias, e.g. xps")
    .option("--json", "Print structured JSON")
    .action(async (sshHost: string, options: { json?: boolean }) => {
      const inspection = await inspectRemoteHost(sshHost);
      if (options.json) {
        console.log(JSON.stringify(inspection, null, 2));
      } else {
        printInspection(inspection);
      }
      if (inspection.checks.some((check) => check.status === "fail")) {
        process.exitCode = 1;
      }
    });

  node
    .command("attach")
    .description("Enroll a remote PlantLab camera node and install its agent configuration")
    .argument("<ssh-host>", "SSH host alias, e.g. xps")
    .option("--coordinator-url <url>", "Coordinator URL the camera node should call", defaultCoordinatorUrl())
    .option("--repo-path <path>", "Remote PlantLab repository path; defaults to inspection result")
    .option("--spool-root <path>", "Remote durable spool root; defaults to the remote user's ~/.local/state/plantlab-agent")
    .option("--yes", "Confirm writes and service restart without prompting")
    .option("--dry-run", "Inspect and print proposed changes without modifying either machine")
    .option("--json", "Print structured JSON")
    .action(
      async (
        sshHost: string,
        options: { coordinatorUrl: string; repoPath?: string; spoolRoot?: string; yes?: boolean; dryRun?: boolean; json?: boolean },
      ) => {
        console.log(`Inspecting ${sshHost}...`);
        const inspection = await inspectRemoteHost(sshHost);
        if (!inspection.plantLabInstalled || !inspection.repoPath) {
          printInspection(inspection);
          console.error(`\nCannot attach ${sshHost}: PlantLab is not installed on the remote host.`);
          process.exitCode = 1;
          return;
        }

        const repoPath = options.repoPath ?? inspection.repoPath;
        const spoolRoot = options.spoolRoot ?? `/home/${inspection.remoteUser ?? sshHost}/.local/state/plantlab-agent`;
        const summary = {
          sshHost,
          nodeName: sshHost,
          role: "camera-node",
          repoPath,
          coordinatorUrl: options.coordinatorUrl,
          spoolRoot,
          dryRun: Boolean(options.dryRun),
        };

        if (options.dryRun) {
          if (options.json) console.log(JSON.stringify({ inspection, proposed: summary }, null, 2));
          else {
            printInspection(inspection);
            console.log("\nDry run - proposed changes:");
            for (const [key, value] of Object.entries(summary)) console.log(`  ${key}: ${value}`);
          }
          return;
        }

        if (!options.yes && process.stdin.isTTY) {
          const ok = await confirm(
            `Write camera-node configuration to ${sshHost}, rotate its node credential, install plantlab-agent.service, and start/restart it? [y/N] `,
          );
          if (!ok) {
            console.log("No changes made.");
            return;
          }
        } else if (!options.yes && !process.stdin.isTTY) {
          console.error("Refusing to modify a remote node without confirmation. Re-run with --yes.");
          process.exitCode = 1;
          return;
        }

        const registered = await registerOrRotateNode(prisma, {
          name: sshHost,
          hostname: inspection.remoteHostname ?? sshHost,
          role: "camera-node",
          operatingSystem: inspection.operatingSystem,
          architecture: inspection.architecture,
          softwareVersion: inspection.plantLabVersion,
          coordinatorUrl: options.coordinatorUrl,
          rotateCredential: true,
        });

        const configured = await configureRemoteAgent({
          sshHost,
          repoPath,
          nodeName: sshHost,
          coordinatorUrl: options.coordinatorUrl,
          credential: registered.credential,
          spoolRoot,
          startService: true,
        });

        const result = { inspection, node: registered.node, configured: configured.status === 0, remoteOutput: configured.stdout.trim() };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log("");
          console.log("Node attached successfully.");
          console.log("");
          console.log(`Name: ${registered.node.name}`);
          console.log(`Role: ${registered.node.role}`);
          console.log(`Coordinator: ${options.coordinatorUrl}`);
          console.log(`Cameras detected: ${inspection.cameras.length}`);
          console.log("Remote agent: plantlab-agent.service installed and start requested");
        }
        if (configured.status !== 0) {
          console.error(configured.stderr.trim() || "Remote configuration command failed.");
          process.exitCode = 1;
        }
      },
    );
}

function printInspection(inspection: Awaited<ReturnType<typeof inspectRemoteHost>>) {
  console.log(`SSH host: ${inspection.sshHost}`);
  console.log(`Resolved host: ${inspection.resolvedHost ?? "(unknown)"}`);
  for (const check of inspection.checks) {
    console.log(`${check.status.toUpperCase()}: ${check.name} - ${check.detail}`);
    if (check.suggestion) console.log(`  Suggested action: ${check.suggestion}`);
  }
  console.log("");
  console.log(`Remote hostname: ${inspection.remoteHostname ?? "(unknown)"}`);
  console.log(`Remote user: ${inspection.remoteUser ?? "(unknown)"}`);
  console.log(`Operating system: ${inspection.operatingSystem ?? "(unknown)"}`);
  console.log(`Architecture: ${inspection.architecture ?? "(unknown)"}`);
  console.log(`PlantLab version: ${inspection.plantLabVersion ?? "(not installed)"}`);
  console.log(`Git repository: ${inspection.repoPath ?? "(not found)"}`);
  console.log(`Git branch: ${inspection.gitBranch ?? "(unknown)"}`);
  console.log(`Git commit: ${inspection.gitCommit ?? "(unknown)"}`);
  console.log(`Configured role: ${inspection.role ?? "(not configured)"}`);
  console.log(`Node.js: ${inspection.nodeVersion ?? "(missing)"}`);
  console.log(`pnpm: ${inspection.pnpmAvailable ? "available" : "missing"}`);
  console.log(`ffmpeg: ${inspection.ffmpegAvailable ? "available" : "missing"}`);
  console.log(`v4l2-ctl: ${inspection.v4l2CtlAvailable ? "available" : "missing"}`);
  console.log(`Tailscale: ${inspection.tailscaleInstalled ? `installed (${inspection.tailscaleConnected ? "connected" : "not connected"})` : "not installed"}`);
  console.log(`Tailscale IPv4: ${inspection.tailscaleIPv4 ?? "(none)"}`);
  console.log(`LAN IPv4: ${inspection.lanIPv4Addresses.join(", ") || "(none)"}`);
  console.log(`Free disk: ${inspection.freeDiskSpace ?? "(unknown)"}`);
  console.log(`Video devices: ${inspection.videoDevices.join(", ") || "(none)"}`);
  console.log(`PlantLab web service: ${inspection.services.web ?? "(unknown)"}`);
  console.log(`PlantLab camera service: ${inspection.services.camera ?? "(unknown)"}`);
  console.log(`PlantLab agent service: ${inspection.services.agent ?? "(unknown)"}`);
  console.log(`Coordinator URL: ${inspection.coordinatorUrl ?? "(not configured)"}`);
  if (inspection.cameras.length > 0) {
    console.log("");
    console.log("Camera inventory:");
    inspection.cameras.forEach((camera, index) => {
      console.log(`${index + 1}. ${camera.name ?? "Unknown camera"}`);
      console.log(`   Device: ${camera.device}`);
      console.log(`   Stable ID: ${camera.stableId ?? "(none)"}`);
      console.log(`   Status: ${camera.supportsCapture ? "available" : "not capture-capable"}`);
    });
  }
}

async function confirm(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
