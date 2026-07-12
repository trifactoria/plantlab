import os from "node:os";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { updateCameraInventory } from "../../lib/operations/agentProtocol";
import { readNodeConfig } from "../../lib/operations/config";
import { createManualCaptureJob, waitForJobCompletion } from "../../lib/operations/manualCapture";
import { markNodeStatus } from "../../lib/operations/nodeCredentials";
import { ensureValidNodeCredential, rotateAndInstallCredential, type CredentialProbeStatus } from "../../lib/operations/credentialRepair";
import { copyEdgeAgentDirectory, runEdgeAgentInstall } from "../../lib/operations/edgeAgentInstall";
import { diagnoseEdgeAgent } from "../../lib/operations/edgeAgentDiagnostics";
import {
  checkCoordinatorReachableFromRemote,
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

        // Pi Zero / low-resource feasibility (Parts 5, 11): offer the
        // lightweight edge agent instead of requiring the full repo +
        // Node.js stack. Checked before the "PlantLab is not installed"
        // abort below, since the whole point of the edge agent is that it
        // does NOT need a full repository clone.
        if (!inspection.fullAgentSupported) {
          console.log("");
          console.log("This device is better suited to the lightweight PlantLab Edge Agent.");
          console.log("");
          if (options.dryRun) {
            printInspection(inspection);
            console.log("\nDry run - would offer to install the PlantLab Edge Agent (lightweight, Python-based) instead of the full Node.js agent.");
            return;
          }
          if (await confirmOrYes("Install the edge agent? [Y/n] ", options.yes, true)) {
            await runEdgeAgentAttach({ sshHost, inspection, options, steps });
            return;
          }
          console.log("Continuing with the full Node.js agent (not recommended for this hardware).");
        }

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

        // Step 2: validate coordinator reachability from the remote node's
        // own vantage point - a warning, not a hard stop, since a
        // transient network blip shouldn't block the rest of convergence.
        const reachability = await checkCoordinatorReachableFromRemote(sshHost, options.coordinatorUrl).catch((error) => ({
          reachable: false,
          detail: error instanceof Error ? error.message : String(error),
        }));
        if (reachability.reachable) {
          steps.complete("Coordinator reachability", reachability.detail);
        } else {
          console.log(`WARN: ${reachability.detail} Continuing - the agent will retry once network access is restored.`);
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

        // Credential validity (Parts 1-2 of the credential-recovery task):
        // a real authenticated probe against the coordinator, not just
        // file existence/permissions - see credentialRepair.ts for why
        // (the real bokchoy failure: a credential file existed with
        // correct permissions but unusable content, and the old
        // file-existence check never caught that). This single call also
        // covers what registerOrRotateNode + convergeNodeRole + wait-for-
        // heartbeat used to do inline here (Part 4: shared, not
        // duplicated, between attach and doctor --fix).
        const registerInput = {
          name: sshHost,
          hostname: inspection.remoteHostname ?? sshHost,
          role: "camera-node" as const,
          operatingSystem: inspection.operatingSystem,
          architecture: inspection.architecture,
          softwareVersion: inspection.plantLabVersion,
          coordinatorUrl: options.coordinatorUrl,
        };
        const credentialInput = {
          sshHost,
          repoPath,
          coordinatorUrl: options.coordinatorUrl,
          role: "camera-node" as const,
          runtime: "node" as const,
          nodeName: sshHost,
          spoolRoot,
          remoteUser: inspection.remoteUser,
          registerInput,
          heartbeatTimeoutMs: options.timeoutMs,
        };

        // Captured before the repair call so the camera-inventory wait
        // below only matches inventory reported during (or after) this
        // same attach run - not stale rows from a previous attempt.
        const heartbeatSince = new Date();

        let probeStatus: CredentialProbeStatus | null = null;
        const repair = options.rotateCredential
          ? await rotateAndInstallCredential(prisma, { ...credentialInput, rotate: true })
          : await (async () => {
              const ensured = await ensureValidNodeCredential(prisma, credentialInput);
              probeStatus = ensured.probe.status;
              return ensured;
            })();

        if (probeStatus && probeStatus !== "valid" && probeStatus !== "unknown") {
          console.log("");
          console.log(`Existing node credential is ${describeCredentialProbeStatus(probeStatus)}.`);
          console.log("Rotating credential automatically...");
          console.log("");
        }

        for (const step of repair.steps) {
          if (step.status === "failed") steps.fail(step.name, sanitizeText(step.detail));
          else steps.complete(step.name, step.detail);
        }
        // A coarse "Credential" milestone for printAttachIncomplete()'s
        // ATTACH_STEP_ORDER pending-list - the granular credential-revoke/
        // credential-create/credential-reuse step names above are still
        // shown individually in the Completed/Failed sections.
        if (repair.steps.some((step) => step.name.startsWith("credential-") && step.status === "completed")) {
          steps.complete("Credential", repair.rotated ? "Rotated and verified." : "Existing credential verified valid.");
        }

        if (!repair.node) {
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }
        const registered = { node: repair.node };

        if (!repair.ok) {
          await printAgentDiagnosis(sshHost, repoPath);
          printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
          process.exitCode = 1;
          return;
        }

        if (repair.rotated) {
          console.log("✓ Previous credential revoked");
          console.log("✓ New credential installed securely");
          console.log("✓ Agent restarted");
          console.log("✓ Authenticated heartbeat received");
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
          printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
          process.exitCode = 1;
          return;
        }
        steps.complete("Camera report", `${inventory.length} camera(s) detected from ${inventorySource}`);

        // Step 16: mark enrollment complete. Clears any "repair-required"
        // flag from a previous attempt - the fresh heartbeat just above is
        // direct evidence the node is genuinely healthy now, so
        // computeNodeStatus() will report "active" from here on.
        await markNodeStatus(prisma, registered.node.id, "pending");

        const result = {
          inspection,
          node: registered.node,
          configured: true,
          credentialRotated: repair.rotated,
          inventorySource,
          cameras: inventory.length,
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

async function promptEdgeAgentRole(sshHost: string, yes?: boolean): Promise<"camera-node" | "greenhouse-node"> {
  const recommended: "camera-node" | "greenhouse-node" = /greenhouse/i.test(sshHost) ? "greenhouse-node" : "camera-node";
  console.log("");
  console.log("Select role:");
  console.log("");
  console.log(`1) Camera node${recommended === "camera-node" ? " (recommended)" : ""}`);
  console.log(`2) Greenhouse node${recommended === "greenhouse-node" ? " (recommended)" : ""}`);
  if (yes || !process.stdin.isTTY) return recommended;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\nRole [1-2, default ${recommended === "greenhouse-node" ? "2" : "1"}]: `)).trim();
    if (!answer) return recommended;
    return answer === "2" ? "greenhouse-node" : "camera-node";
  } finally {
    rl.close();
  }
}

/**
 * The lightweight-agent counterpart of the main attach action's
 * register+converge+wait-heartbeat sequence (Parts 11-12) - installs Only
 * the edge-agent/ directory (never the full repo/Node.js/build), then uses
 * the exact same credential lifecycle (ensureValidNodeCredential /
 * rotateAndInstallCredential with runtime: "python-edge") as every other
 * node type, so credential recovery behaves identically regardless of
 * runtime - see credentialRepair.ts.
 */
async function runEdgeAgentAttach(input: {
  sshHost: string;
  inspection: Awaited<ReturnType<typeof inspectRemoteHost>>;
  options: { coordinatorUrl: string; rotateCredential?: boolean; timeoutMs: number; yes?: boolean; json?: boolean };
  steps: AttachSteps;
}): Promise<void> {
  const { sshHost, inspection, options, steps } = input;

  const role = await promptEdgeAgentRole(sshHost, options.yes);
  steps.complete("Role selection", role);

  console.log(`\nCopying edge agent to ${sshHost}...`);
  const copyResult = await copyEdgeAgentDirectory(sshHost);
  if (copyResult.status !== 0) {
    steps.fail("Copy edge agent", (copyResult.stderr.trim() || "scp failed.").slice(0, 2000));
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  steps.complete("Copy edge agent", `edge-agent/ copied to ~/plantlab-edge-agent on ${sshHost}.`);

  console.log("Running install.sh...");
  const installResult = await runEdgeAgentInstall(sshHost, { role, nodeName: sshHost, coordinatorUrl: options.coordinatorUrl });
  if (installResult.status !== 0) {
    steps.fail("Install edge agent", (installResult.stderr.trim() || installResult.stdout.trim() || "install.sh failed.").slice(0, 2000));
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  steps.complete("Install edge agent", "Dependencies verified, spool prepared, systemd unit installed.");

  const registerInput = {
    name: sshHost,
    hostname: inspection.remoteHostname ?? sshHost,
    role,
    operatingSystem: inspection.operatingSystem,
    architecture: inspection.architecture,
    softwareVersion: null,
    coordinatorUrl: options.coordinatorUrl,
  };
  const credentialInput = {
    sshHost,
    // Unused for runtime: "python-edge" (only the "node" runtime branch of
    // rotateAndInstallCredential() reads repoPath, to run convergeNodeRole)
    // - kept non-empty only for readable diagnostics if it were ever logged.
    repoPath: "~/plantlab-edge-agent",
    coordinatorUrl: options.coordinatorUrl,
    role,
    runtime: "python-edge" as const,
    nodeName: sshHost,
    remoteUser: inspection.remoteUser,
    registerInput,
    heartbeatTimeoutMs: options.timeoutMs,
  };

  const heartbeatSince = new Date();
  let probeStatus: CredentialProbeStatus | null = null;
  const repair = options.rotateCredential
    ? await rotateAndInstallCredential(prisma, { ...credentialInput, rotate: true })
    : await (async () => {
        const ensured = await ensureValidNodeCredential(prisma, credentialInput);
        probeStatus = ensured.probe.status;
        return ensured;
      })();

  if (probeStatus && probeStatus !== "valid" && probeStatus !== "unknown") {
    console.log("");
    console.log(`Existing node credential is ${describeCredentialProbeStatus(probeStatus)}.`);
    console.log("Rotating credential automatically...");
    console.log("");
  }

  for (const step of repair.steps) {
    if (step.status === "failed") steps.fail(step.name, sanitizeText(step.detail));
    else steps.complete(step.name, step.detail);
  }
  if (repair.steps.some((step) => step.name.startsWith("credential-") && step.status === "completed")) {
    steps.complete("Credential", repair.rotated ? "Rotated and verified." : "Existing credential verified valid.");
  }

  if (!repair.node) {
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  if (!repair.ok) {
    await printEdgeAgentDiagnosis(sshHost);
    printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
  }

  if (repair.rotated) {
    console.log("✓ Previous credential revoked");
    console.log("✓ New credential installed securely");
    console.log("✓ Agent restarted");
    console.log("✓ Authenticated heartbeat received");
  }
  steps.complete("Heartbeat", "Agent heartbeat received");

  console.log("Waiting for camera inventory...");
  const inventory = await waitForNodeInventory(repair.node.id, heartbeatSince, options.timeoutMs);
  if (inventory.length === 0) {
    steps.fail("Camera report", "No camera inventory was reported by the edge agent.");
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  steps.complete("Camera report", `${inventory.length} camera(s) detected from active agent heartbeat`);
  await markNodeStatus(prisma, repair.node.id, "pending");

  const result = { inspection, node: repair.node, configured: true, credentialRotated: repair.rotated, runtime: "python-edge", cameras: inventory.length };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("");
  console.log("Node attached successfully.");
  console.log("");
  console.log(`Name: ${repair.node.name}`);
  console.log(`Role: ${repair.node.role}`);
  console.log("Runtime: python-edge (PlantLab Edge Agent)");
  console.log(`Coordinator: ${options.coordinatorUrl}`);
  console.log(`Cameras detected: ${inventory.length}`);
  console.log("Remote agent: healthy");
}

async function printEdgeAgentDiagnosis(sshHost: string): Promise<void> {
  try {
    const diagnostics = await diagnoseEdgeAgent(sshHost);
    console.error("");
    console.error("Edge agent diagnostics:");
    console.error(`- Config: ${diagnostics.configPath ?? "(unknown)"}`);
    if (!diagnostics.configExists) console.error("- edge-agent.json is missing.");
    else if (!diagnostics.configValid) {
      console.error(`- edge-agent.json is incomplete${diagnostics.configError ? `: ${diagnostics.configError}` : "."}`);
      if (!diagnostics.coordinatorUrl) console.error("- coordinatorUrl is missing.");
    }
    console.error(`- Credential: ${diagnostics.credentialPath ?? "(unknown)"} (${diagnostics.credentialHasVariable ? "present" : "missing"})`);
    console.error(`- Service: ${diagnostics.activeState ?? diagnostics.unitStatus ?? "(unknown)"} ${diagnostics.subState ?? ""}`.trim());
    if (diagnostics.restartCount !== null) console.error(`- Restarts: ${diagnostics.restartCount}`);
    if (diagnostics.latestException) console.error(`- Latest failure: ${sanitizeText(diagnostics.latestException)}`);
    const lines = diagnostics.journal.length > 0 ? diagnostics.journal : diagnostics.serviceStatus;
    if (lines.length > 0) {
      console.error("Recent service output:");
      for (const line of lines.slice(-8)) console.error(`  ${sanitizeText(line)}`);
    }
  } catch (error) {
    console.error(`Could not collect edge-agent diagnostics: ${sanitizeError(error)}`);
  }
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
  console.log(`Architecture: ${inspection.architecture ?? "(unknown)"}${inspection.armVersion ? ` (ARM${inspection.armVersion})` : ""}`);
  console.log(`Memory: ${inspection.memoryTotalMb !== null ? `${inspection.memoryTotalMb} MB` : "(unknown)"}${inspection.memoryAvailableMb !== null ? ` (${inspection.memoryAvailableMb} MB available)` : ""}`);
  console.log(`Python: ${inspection.pythonVersion ?? "(missing)"}`);
  console.log("");
  console.log("Full PlantLab Node agent:");
  console.log(`  ${inspection.fullAgentSupported ? "Supported" : "Unsupported or not recommended"}`);
  console.log("");
  console.log("Recommended:");
  console.log(`  ${inspection.recommendedRuntime === "node" ? "PlantLab Node agent" : "PlantLab Edge Agent"}`);
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

const ATTACH_STEP_ORDER = [
  "Inspection",
  "Coordinator reachability",
  "Role confirmation",
  "Credential",
  "Heartbeat",
  "Camera report",
] as const;

function printAttachIncomplete(steps: AttachSteps, sshHost: string, retryCommand?: string): void {
  console.error("");
  console.error("Attachment incomplete.");
  const completed = steps.items.filter((step) => step.status === "completed");
  const failed = steps.items.filter((step) => step.status === "failed");
  const completedNames = new Set(steps.items.map((step) => step.name));
  const pending = ATTACH_STEP_ORDER.filter((name) => !completedNames.has(name));

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
  if (pending.length > 0) {
    console.error("");
    console.error("Not yet reached:");
    for (const name of pending) console.error(`PENDING: ${name}`);
  }
  console.error("");
  console.error(
    steps.items.some((step) => step.name === "Credential" && step.status === "completed")
      ? "A coordinator credential was created or reused for this node - it is retained (not deleted) so a retry can reuse it. See DEPLOYMENT.md \"Coordinator enrollment state\"."
      : "No coordinator registration was written.",
  );
  console.error("Rollback was not attempted automatically; no project data, photos, backups, or capture-source files were deleted.");
  console.error("");
  console.error(`Safe to retry - re-running converges rather than repeating broken steps: ${retryCommand ?? `plantlab node attach ${sshHost}`}`);
  console.error(`Or run guided repair: plantlab doctor --node ${sshHost} --fix`);
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

function describeCredentialProbeStatus(status: CredentialProbeStatus): string {
  switch (status) {
    case "missing":
      return "missing";
    case "empty":
      return "empty";
    case "var-missing":
      return "present but does not set PLANTLAB_NODE_CREDENTIAL";
    case "malformed":
      return "malformed";
    case "rejected":
      return "rejected by the coordinator";
    default:
      return "not valid";
  }
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
