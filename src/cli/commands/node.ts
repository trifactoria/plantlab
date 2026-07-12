import os from "node:os";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { updateCameraInventory } from "../../lib/operations/agentProtocol";
import { readNodeConfig } from "../../lib/operations/config";
import { createManualCaptureJob, waitForJobCompletion } from "../../lib/operations/manualCapture";
import { registerOrRotateNode } from "../../lib/operations/nodeCredentials";
import {
  configureRemoteAgent,
  defaultCoordinatorUrl,
  diagnoseRemoteAgent,
  inspectRemoteHost,
  type RemoteAgentDiagnostics,
  type RemoteCameraInfo,
} from "../../lib/operations/remoteNode";
import { resolveAllPaths } from "../../lib/paths.server";
import { prisma } from "../../lib/prisma";
import type { CameraFormat } from "../../lib/v4l2";
import { runCameraAttachFlow } from "./camera";
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
  const node = program
    .command("node")
    .description("Inspect, enroll, and configure PlantLab deployment nodes")
    .addHelpText(
      "after",
      `

Examples:
  plantlab node info
  plantlab node inspect xps
  plantlab node attach xps
  plantlab node attach xps --coordinator-url http://plantlab:3000
`,
    );

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
    .option("--rotate-credential", "Rotate the node credential even if a valid credential file already exists")
    .option("--timeout-ms <ms>", "Timeout waiting for heartbeat and camera inventory", (value) => Number(value), 45_000)
    .option("--yes", "Confirm writes and service restart without prompting")
    .option("--dry-run", "Inspect and print proposed changes without modifying either machine")
    .option("--json", "Print structured JSON")
    .action(
      async (
        sshHost: string,
        options: {
          coordinatorUrl: string;
          repoPath?: string;
          spoolRoot?: string;
          rotateCredential?: boolean;
          timeoutMs: number;
          yes?: boolean;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        const steps = new AttachSteps();
        console.log(`Inspecting ${sshHost}...`);
        const inspection = await inspectRemoteHost(sshHost);
        const failedInspection = inspection.checks.find((check) => check.status === "fail");
        if (failedInspection) {
          steps.fail("Inspection", failedInspection.detail);
          printInspection(inspection);
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }
        steps.complete("Inspection", `Connected to ${sshHost}`);
        if (!inspection.plantLabInstalled || !inspection.repoPath) {
          printInspection(inspection);
          console.error(`\nCannot attach ${sshHost}: PlantLab is not installed on the remote host.`);
          process.exitCode = 1;
          return;
        }

        const repoPath = options.repoPath ?? inspection.repoPath;
        const spoolRoot = options.spoolRoot ?? `/home/${inspection.remoteUser ?? sshHost}/.local/state/plantlab-agent`;
        const currentRole = inspection.role ?? "not configured";
        const desiredRole = "camera-node";
        const summary = {
          sshHost,
          nodeName: sshHost,
          currentRole,
          role: desiredRole,
          repoPath,
          coordinatorUrl: options.coordinatorUrl,
          spoolRoot,
          rotateCredential: Boolean(options.rotateCredential),
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

        if (inspection.role && inspection.role !== desiredRole) {
          console.log("");
          console.log(`${sshHost} is currently configured as ${inspection.role}.`);
          console.log("");
          console.log("This will:");
          console.log("- preserve the local PlantLab data and files");
          console.log("- stop the local web service");
          console.log("- stop the local camera scheduler");
          console.log(`- configure the machine to report cameras to ${os.hostname()}`);
          console.log("- start the camera-node agent");
          console.log("- leave existing SQLite data untouched");
          if (!(await confirmOrYes(`\nConvert ${sshHost} from ${inspection.role} to camera-node? [Y/n] `, options.yes, true))) {
            console.log("No changes made.");
            return;
          }
          steps.complete("Role confirmation", `Conversion from ${inspection.role} confirmed`);
        }

        if (
          !(await confirmOrYes(
            `Write camera-node configuration to ${sshHost}, install plantlab-agent.service, stop inappropriate services, and start the agent? [Y/n] `,
            options.yes,
            true,
          ))
        ) {
          console.log("No changes made.");
          return;
        }

        let diagnostics: RemoteAgentDiagnostics | null = null;
        try {
          diagnostics = await diagnoseRemoteAgent(sshHost, repoPath);
        } catch {
          diagnostics = null;
        }
        const needsCredentialRepair =
          !diagnostics?.credentialExists || diagnostics.credentialMode !== "600" || diagnostics.credentialDirMode !== "700";
        const rotateCredential = Boolean(options.rotateCredential || needsCredentialRepair);

        let registered: Awaited<ReturnType<typeof registerOrRotateNode>>;
        try {
          registered = await registerOrRotateNode(prisma, {
            name: sshHost,
            hostname: inspection.remoteHostname ?? sshHost,
            role: "camera-node",
            operatingSystem: inspection.operatingSystem,
            architecture: inspection.architecture,
            softwareVersion: inspection.plantLabVersion,
            coordinatorUrl: options.coordinatorUrl,
            rotateCredential,
          });
          steps.complete("Coordinator registration", rotateCredential ? "Credential created or rotated" : "Existing credential retained");
        } catch (error) {
          steps.fail("Coordinator registration", sanitizeError(error));
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }

        const heartbeatSince = new Date();
        const configured = await configureRemoteAgent({
          sshHost,
          repoPath,
          nodeName: sshHost,
          coordinatorUrl: options.coordinatorUrl,
          credential: registered.credential || null,
          spoolRoot,
          startService: true,
        });
        if (configured.status !== 0) {
          steps.fail("Remote configuration write", sanitizeText(configured.stderr.trim() || configured.stdout.trim() || "Remote configuration command failed."));
          await printAgentDiagnosis(sshHost, repoPath);
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }
        steps.complete("Remote configuration write", "Config, credential file, and user service unit verified");
        steps.complete("Service unit installation", "plantlab-agent.service installed");
        steps.complete("Service start", "plantlab-agent.service start requested; web/camera services stopped for camera-node role");

        console.log("Waiting for heartbeat...");
        const heartbeat = await waitForNodeHeartbeat(registered.node.id, heartbeatSince, options.timeoutMs);
        if (!heartbeat) {
          steps.fail("Heartbeat", `No heartbeat received within ${Math.round(options.timeoutMs / 1000)} seconds`);
          await printAgentDiagnosis(sshHost, repoPath);
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }
        steps.complete("Heartbeat", "Agent heartbeat received");

        console.log("Waiting for camera inventory...");
        let inventory = await waitForNodeInventory(registered.node.id, heartbeatSince, options.timeoutMs);
        let inventorySource = "active agent heartbeat";
        if (inventory.length === 0 && inspection.cameras.length > 0) {
          if (await confirmOrYes(`Agent inventory unavailable. Probe cameras on ${sshHost} over SSH? [Y/n] `, options.yes, true)) {
            inventory = await saveSshProbeInventory(registered.node.id, inspection.cameras);
            inventorySource = "live SSH probe";
          }
        }
        if (inventory.length === 0) {
          steps.fail("Camera report", "No camera inventory was reported or discovered by SSH probe");
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }
        steps.complete("Camera report", `${inventory.length} camera(s) detected from ${inventorySource}`);

        const result = {
          inspection,
          node: registered.node,
          configured: true,
          credentialRotated: registered.rotated,
          inventorySource,
          cameras: inventory.length,
          remoteOutput: configured.stdout.trim(),
        };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log("");
          console.log("Node attached successfully.");
          console.log("");
          console.log(`Name: ${registered.node.name}`);
          console.log(`Role: ${registered.node.role}`);
          console.log(`Coordinator: ${options.coordinatorUrl}`);
          console.log(`Cameras detected: ${inventory.length} (${inventorySource})`);
          console.log("Remote agent: healthy");
        }

        if (await confirmOptional("\nConfigure a camera now? [Y/n] ", options.yes, true)) {
          const attached = await runCameraAttachFlow({ node: sshHost, yes: options.yes });
          console.log("");
          console.log("Camera attached.");
          console.log(`Camera: ${attached.camera.name ?? attached.camera.stableId}`);
          console.log(`Capture source: ${attached.captureSource.name}`);

          if (await confirmOptional("\nRun a test capture now? [Y/n] ", options.yes, true)) {
            const created = await createManualCaptureJob(prisma, { nodeName: sshHost, assignmentId: attached.assignment.id });
            console.log(created.reused ? "WARN: Reusing an already queued/claimed test job." : "PASS: Job created");
            const completed = await waitForJobCompletion(prisma, created.job.id, { timeoutMs: 120_000 });
            if (completed?.status === "completed") {
              console.log("PASS: Agent claimed job");
              console.log("PASS: Frame uploaded");
              console.log("PASS: Checksum verified");
              console.log("PASS: SourceCapture created on coordinator");
            } else {
              console.error(
                completed?.status === "failed"
                  ? `FAIL: Test capture failed: ${completed.errorMessage ?? "Unknown error"}`
                  : "FAIL: Timed out waiting for test capture completion.",
              );
              process.exitCode = 1;
              return;
            }
          }

          console.log("");
          console.log(`${sshHost} camera node is ready.`);
          console.log(`Node: ${sshHost}`);
          console.log(`Coordinator: ${options.coordinatorUrl}`);
          console.log(`Camera: ${attached.camera.name ?? attached.camera.stableId}`);
          console.log(`Capture source: ${attached.captureSource.name}`);
          console.log("Agent: healthy");
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
  if (inspection.bridgeIPv4Addresses.length > 0) console.log(`Bridge IPv4: ${inspection.bridgeIPv4Addresses.join(", ")}`);
  if (inspection.otherIPv4Addresses.length > 0) console.log(`Other IPv4: ${inspection.otherIPv4Addresses.join(", ")}`);
  if (inspection.ipv6Addresses.length > 0) console.log(`IPv6: ${inspection.ipv6Addresses.join(", ")}`);
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

async function confirmOrYes(question: string, yes: boolean | undefined, defaultYes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error("Refusing to modify a remote node without confirmation. Re-run with --yes.");
    process.exitCode = 1;
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function confirmOptional(question: string, yes: boolean | undefined, defaultYes: boolean): Promise<boolean> {
  if (yes || !process.stdin.isTTY) return false;
  return confirmOrYes(question, false, defaultYes);
}

class AttachSteps {
  readonly items: { name: string; status: "completed" | "failed"; detail: string }[] = [];

  complete(name: string, detail: string): void {
    this.items.push({ name, status: "completed", detail });
  }

  fail(name: string, detail: string): void {
    this.items.push({ name, status: "failed", detail });
  }
}

function printAttachIncomplete(steps: AttachSteps, sshHost: string): void {
  console.error("");
  console.error("Attachment incomplete.");
  const completed = steps.items.filter((step) => step.status === "completed");
  const failed = steps.items.filter((step) => step.status === "failed");
  if (completed.length > 0) {
    console.error("");
    console.error("Completed:");
    for (const step of completed) console.error(`PASS: ${step.name}: ${step.detail}`);
  }
  if (failed.length > 0) {
    console.error("");
    console.error("Failed:");
    for (const step of failed) console.error(`FAIL: ${step.name}: ${step.detail}`);
  }
  console.error("");
  console.error("Was anything changed? Completed steps above may have changed coordinator registration or remote user-service files.");
  console.error("Rollback was not attempted automatically; no project data, photos, backups, or capture-source files were deleted.");
  console.error("");
  console.error(`Suggested repair: plantlab doctor --node ${sshHost} --fix`);
}

function sanitizeError(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error));
}

function sanitizeText(value: string): string {
  return value.replace(/pln_[A-Za-z0-9_-]+/g, "pln_[redacted]");
}

async function printAgentDiagnosis(sshHost: string, repoPath: string): Promise<void> {
  try {
    const diagnostics = await diagnoseRemoteAgent(sshHost, repoPath);
    console.error("");
    console.error("Agent diagnostics:");
    if (!diagnostics.credentialExists) console.error("- Credential file is missing.");
    else if (diagnostics.credentialMode !== "600" || diagnostics.credentialDirMode !== "700") {
      console.error(`- Credential permissions are credential=${diagnostics.credentialMode ?? "unknown"} directory=${diagnostics.credentialDirMode ?? "unknown"}; expected 0600/0700.`);
    }
    if (!diagnostics.configExists) console.error("- plantlab.config.json is missing.");
    if (!diagnostics.coordinatorUrl) console.error("- Coordinator URL is not configured.");
    if (diagnostics.coordinatorReachable === false) console.error(`- Coordinator is unreachable from the node: ${diagnostics.coordinatorUrl ?? "(unknown)"}.`);
    if (!diagnostics.nodePath) console.error("- Node executable was not found in the systemd environment.");
    if (!diagnostics.runBin) console.error("- Neither pnpm nor npm was found in the systemd environment.");
    if (!diagnostics.agentScriptExists) console.error("- Agent service script is missing from the repository.");
    if (!diagnostics.spoolWritable) console.error("- Agent spool root is missing or not writable.");
    if (!diagnostics.ffmpegAvailable) console.error("- ffmpeg is missing.");
    if (!diagnostics.v4l2CtlAvailable) console.error("- v4l2-ctl is missing.");
    if (diagnostics.agentJournal.length > 0) {
      console.error("Recent agent logs:");
      for (const line of diagnostics.agentJournal.slice(-8)) console.error(`  ${sanitizeText(line)}`);
    }
  } catch (error) {
    console.error(`Could not collect remote agent diagnostics: ${sanitizeError(error)}`);
  }
}

async function waitForNodeHeartbeat(nodeId: string, since: Date, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const node = await prisma.plantLabNode.findUnique({ where: { id: nodeId }, select: { lastHeartbeatAt: true } });
    if (node?.lastHeartbeatAt && node.lastHeartbeatAt >= since) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function waitForNodeInventory(nodeId: string, since: Date, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const cameras = await prisma.nodeCamera.findMany({ where: { nodeId, lastSeenAt: { gte: since } }, orderBy: { name: "asc" } });
    if (cameras.length > 0) return cameras;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return [];
}

async function saveSshProbeInventory(nodeId: string, cameras: RemoteCameraInfo[]) {
  return updateCameraInventory(
    prisma,
    nodeId,
    cameras
      .filter((camera) => camera.device)
      .map((camera) => ({
        stableId: camera.stableId ?? `device:${camera.device}`,
        devicePath: camera.device,
        name: camera.name,
        formats: Array.isArray(camera.formats) ? (camera.formats as CameraFormat[]) : [],
        available: camera.supportsCapture,
      })),
  );
}
