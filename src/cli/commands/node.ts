import os from "node:os";
import type { Command } from "commander";
import { readNodeConfig } from "../../lib/operations/config";
import { resolveAllPaths } from "../../lib/paths.server";
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
  const node = program.command("node").description("Inspect this node and (later) other nodes in the deployment");

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

      console.log("");
      console.log("Remote node registration is not implemented yet - see ARCHITECTURE.md for the deferred capture-agent protocol.");
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
}
