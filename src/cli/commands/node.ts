import os from "node:os";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { requestCameraInventoryRefresh, updateCameraInventory } from "../../lib/operations/agentProtocol";
import { readNodeConfig } from "../../lib/operations/config";
import { createManualCaptureJob, waitForJobCompletion } from "../../lib/operations/manualCapture";
import { markNodeStatus } from "../../lib/operations/nodeCredentials";
import { ensureValidNodeCredential, rotateAndInstallCredential, waitForNodeHeartbeat, type CredentialProbeStatus } from "../../lib/operations/credentialRepair";
import { discoverCoordinatorUrl } from "../../lib/operations/coordinatorDiscovery";
import {
  copyEdgeAgentDirectory,
  copyEdgeWheelhouse,
  edgeAttachTimeoutPolicy,
  edgeAgentInstallChangeStatus,
  inspectRemoteEdgeRuntime,
  inspectRemoteDht22Support,
  inspectEdgeAgentService,
  inspectRemoteKasaSupport,
  installRemoteDht22Support,
  installRemoteKasaSupport,
  localEdgeAgentVersion,
  readInstalledEdgeAgentVersion,
  readRemoteEdgeAgentConfig,
  readRemoteGreenhouseSecretStatus,
  reconcileEdgeAgentInstall,
  runEdgeAgentInstall,
  setRemoteGreenhouseSensorDriverMode,
  startEdgeAgentService,
  stopEdgeAgentService,
  verifyEdgeCommand,
  writeRemoteGreenhouseSecrets,
  type EdgeAttachTimeoutPolicy,
  type EdgeInstallReconciliation,
  type RemoteEdgeRuntimeStatus,
} from "../../lib/operations/edgeAgentInstall";
import {
  deriveCapabilitiesFromEdgeConfig,
  greenhouseConfigSummary,
  pythonKasaReadiness,
  redactedGreenhouseSummary,
  type GreenhousePowerConfig,
  type GreenhouseSensorConfig,
} from "../../lib/operations/greenhouseConfig";
import { diagnoseEdgeAgent } from "../../lib/operations/edgeAgentDiagnostics";
import {
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
import { parseStrictMenuChoice } from "../promptValidation";

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
  plantlab node attach xps --coordinator-url http://192.168.1.66:3000
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
    .option("--coordinator-url <url>", "Coordinator URL the camera node should call - tried first, but still validated; omit to auto-discover a reachable LAN/Tailscale address")
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
          coordinatorUrl?: string;
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

        // Coordinator URL discovery (Part 1): never trust a URL until this
        // node has proven - via a real request it makes itself - that it
        // can reach GET /api/node-info and get back a genuine PlantLab
        // coordinator response. The real greenhouse-zero bug: silently
        // defaulting to the coordinator's own hostname
        // (`http://plantlab:3000`) is only ever resolvable from the
        // coordinator itself. Runs before ANY credential/config write, and
        // before the edge-agent-vs-full-agent branch below, since both
        // paths need a validated URL.
        console.log("");
        const discovery = await discoverCoordinatorUrl(sshHost, {
          explicitUrl: options.coordinatorUrl ?? null,
          log: (line) => console.log(line),
        });
        if (!discovery.selected) {
          steps.fail("Coordinator discovery", "No reachable PlantLab coordinator address was found from this node.");
          console.error("");
          console.error(`Cannot attach ${sshHost}: no candidate coordinator URL was reachable from this node.`);
          console.error("Check that the coordinator's web service is running and that this node is on the same network (or Tailscale tailnet).");
          printAttachIncomplete(steps, sshHost);
          process.exitCode = 1;
          return;
        }
        steps.complete("Coordinator discovery", `Selected ${discovery.selected}`);
        const coordinatorUrl = discovery.selected;

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
            console.log(`\nDry run - would offer to install the PlantLab Edge Agent (lightweight, Python-based) instead of the full Node.js agent, using coordinator ${coordinatorUrl}.`);
            return;
          }
          if (await confirmOrYes("Install the edge agent? [Y/n] ", options.yes, true)) {
            await runEdgeAgentAttach({ sshHost, inspection, coordinatorUrl, options, steps });
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
          coordinatorUrl,
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
          coordinatorUrl,
        };
        const credentialInput = {
          sshHost,
          repoPath,
          coordinatorUrl,
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
          console.log(`Coordinator: ${coordinatorUrl}`);
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
          console.log(`Coordinator: ${coordinatorUrl}`);
          console.log(`Camera: ${attached.camera.name ?? attached.camera.stableId}`);
          console.log(`Capture source: ${attached.captureSource.name}`);
          console.log("Agent: healthy");
        }
      },
    );
}

async function promptEdgeAgentRole(
  sshHost: string,
  yes?: boolean,
  existingRole?: string | null,
): Promise<"camera-node" | "greenhouse-node"> {
  const existing = existingRole === "greenhouse-node" || existingRole === "camera-node" ? existingRole : null;
  const recommended: "camera-node" | "greenhouse-node" = existing ?? (/greenhouse/i.test(sshHost) ? "greenhouse-node" : "camera-node");
  console.log("");
  if (existing) {
    console.log(`Existing node role: ${existing}`);
    console.log("");
  }
  console.log("Select role:");
  console.log("");
  console.log(`1) Camera node${recommended === "camera-node" ? " (recommended)" : ""}`);
  console.log(`2) Greenhouse node${recommended === "greenhouse-node" ? " (recommended)" : ""}`);
  if (yes || !process.stdin.isTTY) return recommended;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const fallback = recommended === "greenhouse-node" ? 2 : 1;
    for (;;) {
      const answer = await rl.question(`\nRole [1-2, default ${fallback}]: `);
      const choice = parseStrictMenuChoice(answer, 2, fallback);
      if (choice !== null) return choice === 2 ? "greenhouse-node" : "camera-node";
      console.log("Please enter 1 or 2.");
    }
  } finally {
    rl.close();
  }
}

type GreenhouseAttachSelection = {
  cameraEnabled: boolean;
  sensors?: GreenhouseSensorConfig[] | null;
  power?: GreenhousePowerConfig | null;
  disableSensors?: boolean;
  disablePower?: boolean;
  shouldWriteSecrets: boolean;
  secrets?: { kasaUsername: string; kasaPassword: string };
};

async function promptGreenhouseAttachSelection(input: {
  existingConfig: Record<string, unknown>;
  secretFileExists: boolean;
  pythonVersion?: string | null;
  yes?: boolean;
}): Promise<GreenhouseAttachSelection> {
  const { existingConfig, secretFileExists, pythonVersion, yes } = input;
  let summary: ReturnType<typeof greenhouseConfigSummary>;
  try {
    summary = greenhouseConfigSummary(existingConfig);
  } catch (error) {
    console.log(`Existing greenhouse configuration has validation errors: ${sanitizeError(error)}`);
    summary = { sensors: [], power: null, capabilities: deriveCapabilitiesFromEdgeConfig(existingConfig) };
  }
  const existingCamera = summary.capabilities.includes("camera") || !existingConfig.role;
  const hasExistingGreenhouseConfig = summary.sensors.length > 0 || summary.power !== null || existingConfig.role === "greenhouse-node";

  if (hasExistingGreenhouseConfig) {
    console.log("");
    console.log("Existing greenhouse configuration:");
    printGreenhouseSummary(existingConfig, secretFileExists, pythonVersion ?? null);
  }

  const cameraEnabled = await promptGreenhouseBoolean("Configure camera support? [Y/n] ", yes, existingCamera);
  let sensors: GreenhouseSensorConfig[] | null | undefined;
  let power: GreenhousePowerConfig | null | undefined;
  let disableSensors = false;
  let disablePower = false;

  if (summary.sensors.length > 0) {
    if (await promptGreenhouseBoolean("Reconfigure environmental sensors? [y/N] ", yes, false)) {
      sensors = await promptSensorDefinitions(yes);
    } else if (await promptGreenhouseBoolean("Disable configured environmental sensors? [y/N] ", yes, false)) {
      disableSensors = true;
    }
  } else if (await promptGreenhouseBoolean("Configure environmental sensors? [y/N] ", yes, false)) {
    sensors = await promptSensorDefinitions(yes);
  }

  if (summary.power) {
    if (await promptGreenhouseBoolean("Reconfigure power control and future automation support? [y/N] ", yes, false)) {
      power = await promptPowerConfig(yes);
    } else if (await promptGreenhouseBoolean("Disable configured power control? [y/N] ", yes, false)) {
      disablePower = true;
    }
  } else if (await promptGreenhouseBoolean("Configure power control and future automation support? [y/N] ", yes, false)) {
    power = await promptPowerConfig(yes);
  }

  const powerWillBeConfigured = !disablePower && (power !== undefined ? power !== null : summary.power !== null);
  let shouldWriteSecrets = false;
  let secrets: { kasaUsername: string; kasaPassword: string } | undefined;
  if (powerWillBeConfigured) {
    const readiness = pythonKasaReadiness(pythonVersion);
    console.log(readiness.detail);
    const credentialsNeeded = !secretFileExists || power !== undefined;
    if (credentialsNeeded && (await promptGreenhouseBoolean("Configure Kasa credentials now? [y/N] ", yes, false))) {
      secrets = await promptKasaCredentials();
      shouldWriteSecrets = Boolean(secrets);
    } else if (secretFileExists && (await promptGreenhouseBoolean("Reconfigure Kasa credentials? [y/N] ", yes, false))) {
      secrets = await promptKasaCredentials();
      shouldWriteSecrets = Boolean(secrets);
    }
  }

  return { cameraEnabled, sensors, power, disableSensors, disablePower, shouldWriteSecrets, secrets };
}

function printGreenhouseSummary(config: Record<string, unknown>, secretFileExists: boolean, pythonVersion: string | null): void {
  let summary: ReturnType<typeof redactedGreenhouseSummary>;
  try {
    summary = redactedGreenhouseSummary(config, { secretFileExists, pythonVersion });
  } catch (error) {
    console.log(`  Config summary unavailable: ${sanitizeError(error)}`);
    return;
  }
  console.log(`  Role: ${summary.role ?? "(missing)"}`);
  console.log(`  Capabilities: ${summary.capabilities.join(", ") || "(none)"}`);
  console.log(`  Sensors: ${summary.sensors.length}`);
  for (const sensor of summary.sensors) {
    console.log(`    - ${sensor.key}: ${sensor.name}, ${sensor.type}, BCM GPIO ${sensor.gpio}, ${sensor.placement ?? "no placement"}, ${sensor.enabled ? "enabled" : "disabled"}`);
  }
  if (summary.power) {
    console.log(`  Power: ${summary.power.provider} at ${summary.power.host}`);
    const outlets = Object.entries(summary.power.outlets);
    console.log(`  Outlets: ${outlets.length > 0 ? outlets.map(([key, value]) => `${key}=${value}`).join(", ") : "(none)"}`);
  } else {
    console.log("  Power: not configured");
  }
  console.log(`  Greenhouse secret file: ${secretFileExists ? "present" : "missing"}`);
  if (summary.pythonKasaReadiness) console.log(`  Kasa readiness: ${summary.pythonKasaReadiness.status} (${summary.pythonKasaReadiness.detail})`);
}

async function promptSensorDefinitions(yes?: boolean): Promise<GreenhouseSensorConfig[]> {
  if (yes || !process.stdin.isTTY) return [];
  const sensors: GreenhouseSensorConfig[] = [];
  do {
    const key = await promptText("Sensor logical key: ");
    const name = await promptText("Sensor display name: ");
    const gpio = await promptBcmGpio();
    const placement = await promptText("Physical placement (optional): ", false);
    const enabled = await promptGreenhouseBoolean("Enabled? [Y/n] ", false, true);
    sensors.push({
      key,
      name,
      type: "dht22",
      gpio,
      placement: placement || null,
      enabled,
    });
  } while (await promptGreenhouseBoolean("Add another sensor? [y/N] ", false, false));
  return sensors;
}

async function promptBcmGpio(): Promise<number> {
  for (;;) {
    const gpioText = await promptText("BCM GPIO number: ");
    if (/^(?:[0-9]|1[0-9]|2[0-7])$/.test(gpioText)) return Number(gpioText);
    console.log("Please enter a BCM GPIO number from 0 to 27.");
  }
}

async function promptPowerConfig(yes?: boolean): Promise<GreenhousePowerConfig | null> {
  if (yes || !process.stdin.isTTY) return null;
  console.log("Provider: kasa");
  const host = await promptText("Kasa host: ");
  const fans = await promptText("Fans outlet alias (optional): ", false);
  const water = await promptText("Water outlet alias (optional): ", false);
  const lights = await promptText("Lights outlet alias (optional): ", false);
  const outlets: GreenhousePowerConfig["outlets"] = {};
  if (fans) outlets.fans = fans;
  if (water) outlets.water = water;
  if (lights) outlets.lights = lights;
  return { provider: "kasa", host, outlets };
}

async function promptGreenhouseBoolean(question: string, yes: boolean | undefined, defaultYes: boolean): Promise<boolean> {
  if (yes || !process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function promptText(question: string, required = true): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim();
      if (answer || !required) return answer;
      console.log("A value is required.");
    }
  } finally {
    rl.close();
  }
}

async function promptKasaCredentials(): Promise<{ kasaUsername: string; kasaPassword: string } | undefined> {
  if (!process.stdin.isTTY) return undefined;
  for (;;) {
    // Deliberately visible during this development-stage trusted-home-network
    // flow. Harden this later before treating Kasa credentials as production
    // secret entry UX.
    const kasaUsername = await promptText("Kasa username: ");
    const kasaPassword = await promptText("Kasa password: ");
    console.log("");
    console.log(`Kasa username: ${kasaUsername}`);
    console.log(`Kasa password: ${kasaPassword}`);
    if (await promptGreenhouseBoolean("Use these Kasa credentials? [Y/n] ", false, true)) {
      return { kasaUsername, kasaPassword };
    }
    console.log("Re-enter Kasa credentials.");
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
  coordinatorUrl: string;
  options: { rotateCredential?: boolean; timeoutMs: number; yes?: boolean; json?: boolean };
  steps: AttachSteps;
}): Promise<void> {
  const { sshHost, inspection, coordinatorUrl, options, steps } = input;
  const timeoutPolicy = edgeAttachTimeoutPolicy(inspection);
  const heartbeatTimeoutMs = options.timeoutMs !== 45_000 ? options.timeoutMs : timeoutPolicy.heartbeatMs;
  const inventoryTimeoutMs = options.timeoutMs !== 45_000 ? options.timeoutMs : timeoutPolicy.inventoryMs;
  if (timeoutPolicy.lowResource) {
    console.log("Low-resource edge node detected; using extended installation timeouts.");
  }

  const existingConfigResult = await readRemoteEdgeAgentConfig(sshHost).catch((error) => {
    console.log(`Could not read existing edge-agent configuration; continuing with a fresh config view: ${sanitizeError(error)}`);
    return { configPath: null, exists: false, config: {} as Record<string, unknown>, error: null };
  });
  if (existingConfigResult.error) {
    console.log(`Existing edge-agent config could not be parsed and will be repaired: ${existingConfigResult.error}`);
  }
  const existingConfig = existingConfigResult.config as Record<string, unknown>;
  const existingRole = typeof existingConfig.role === "string" ? existingConfig.role : inspection.role;
  const role = await promptEdgeAgentRole(sshHost, options.yes, existingRole);
  if ((existingRole === "greenhouse-node" || existingRole === "camera-node") && existingRole !== role) {
    if (!(await confirmOrYes(`Change node role from ${existingRole} to ${role}? [y/N] `, options.yes, false))) {
      steps.fail("Role selection", "Role change was not confirmed.");
      printAttachIncomplete(steps, sshHost);
      process.exitCode = 1;
      return;
    }
  }
  steps.complete("Role selection", role);
  let greenhouseSelection: GreenhouseAttachSelection | null = null;
  let registerCapabilities = role === "camera-node" ? ["camera"] : ["camera"];
  if (role === "greenhouse-node") {
    const secretStatus = await readRemoteGreenhouseSecretStatus(sshHost).catch(() => ({
      path: null,
      exists: false,
      mode: null,
      owner: null,
      hasKasaUsername: false,
      hasKasaPassword: false,
    }));
    greenhouseSelection = await promptGreenhouseAttachSelection({
      existingConfig,
      secretFileExists: secretStatus.exists,
      pythonVersion: inspection.pythonVersion,
      yes: options.yes,
    });
    const capabilityConfig: Record<string, unknown> = {
      ...existingConfig,
      role: "greenhouse-node",
      nodeName: sshHost,
      coordinatorUrl,
      capabilities: greenhouseSelection.cameraEnabled ? ["camera"] : [],
    };
    if (greenhouseSelection.disableSensors) delete capabilityConfig.sensors;
    else if (greenhouseSelection.sensors !== undefined && greenhouseSelection.sensors !== null) capabilityConfig.sensors = greenhouseSelection.sensors;
    if (greenhouseSelection.disablePower) delete capabilityConfig.power;
    else if (greenhouseSelection.power !== undefined) capabilityConfig.power = greenhouseSelection.power;
    registerCapabilities = deriveCapabilitiesFromEdgeConfig(capabilityConfig);
    steps.complete("Greenhouse configuration", `${registerCapabilities.join(", ") || "no"} capabilities selected.`);
  }
  const sourceVersion = await localEdgeAgentVersion();
  const installedBefore = await readInstalledEdgeAgentVersion(sshHost);
  const serviceState = await inspectEdgeAgentService(sshHost, { timeoutMs: timeoutPolicy.serviceMs }).catch((error) => {
    console.log(`Could not inspect existing edge-agent service state: ${sanitizeError(error)}`);
    return null;
  });
  let stoppedExistingService = false;
  let serviceStarted = false;
  const restoreStoppedService = async () => {
    if (stoppedExistingService && serviceState?.active && !serviceStarted) {
      console.log("Restoring previously running edge agent service...");
      await startEdgeAgentService(sshHost, { timeoutMs: timeoutPolicy.serviceMs }).catch((error) => {
        console.error(`WARN: could not restore plantlab-edge-agent.service: ${sanitizeError(error)}`);
      });
    }
  };

  if (serviceState?.active) {
    console.log("Stopping existing edge agent...");
    const stop = await stopEdgeAgentService(sshHost, { timeoutMs: timeoutPolicy.serviceMs }).catch((error) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      status: 124,
    }));
    if (stop.status !== 0) {
      steps.fail("Service stop", (stop.stderr.trim() || "Timed out stopping plantlab-edge-agent.service.").slice(0, 2000));
      printAttachIncomplete(steps, sshHost);
      process.exitCode = 1;
      return;
    }
    stoppedExistingService = true;
    steps.complete("Service stop", "Existing plantlab-edge-agent.service stopped.");
    console.log("Existing edge agent stopped.");
  } else {
    steps.complete("Service stop", serviceState?.exists ? "Service exists and was not active." : "Service not installed yet.");
  }

  console.log(`\nCopying edge agent to ${sshHost}...`);
  const copyResult = await copyEdgeAgentDirectory(sshHost, { timeoutMs: timeoutPolicy.copyMs }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    status: 124,
  }));
  if (copyResult.status !== 0) {
    steps.fail("Copy edge agent", (copyResult.stderr.trim() || "scp failed.").slice(0, 2000));
    await restoreStoppedService();
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  steps.complete("Copy edge agent", `edge-agent/ copied to ~/plantlab-edge-agent on ${sshHost}.`);
  console.log("Files copied.");

  console.log(timeoutPolicy.lowResource ? "Running remote install on low-resource node..." : "Running install.sh...");
  const installStartedAt = Date.now();
  let installTimedOut = false;
  const installResult = await runEdgeAgentInstall(sshHost, { role, nodeName: sshHost, coordinatorUrl }, { timeoutMs: timeoutPolicy.installMs }).catch((error) => {
    installTimedOut = isTimeoutError(error);
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), status: 124 };
  });
  if (installResult.status !== 0) {
    if (installTimedOut) {
      console.log(`Edge-agent install did not finish within ${Math.round(timeoutPolicy.installMs / 1000)} seconds.`);
      console.log("Checking whether installation completed remotely...");
      const reconciled = await waitForInstallReconciliation(sshHost, sourceVersion, timeoutPolicy);
      if (reconciled.status !== "completed") {
        steps.fail("Install edge agent", `${reconciled.status}: ${reconciled.detail}`);
        printInstallReconciliation(reconciled);
        await restoreStoppedService();
        printAttachIncomplete(steps, sshHost);
        process.exitCode = 1;
        return;
      }
      steps.complete("Install edge agent", `Completed after local timeout: ${reconciled.detail}`);
    } else {
      steps.fail("Install edge agent", (installResult.stderr.trim() || installResult.stdout.trim() || "install.sh failed.").slice(0, 2000));
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`Remote install completed in ${Math.round((Date.now() - installStartedAt) / 1000)} seconds.`);
  }
  const installedAfter = await readInstalledEdgeAgentVersion(sshHost);
  if (sourceVersion.contentHash && installedAfter?.contentHash && sourceVersion.contentHash !== installedAfter.contentHash) {
    steps.fail("Install edge agent", `FAILED: source edge-agent hash ${sourceVersion.contentHash} but installed hash is ${installedAfter.contentHash}.`);
    await restoreStoppedService();
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  const installStatus = edgeAgentInstallChangeStatus(sourceVersion, installedBefore);
  steps.complete(
    "Install edge agent",
    `${installStatus}: source edge-agent ${sourceVersion.version ?? "(unknown)"} ${sourceVersion.contentHash?.slice(0, 12) ?? "(no hash)"}; installed ${installedAfter?.version ?? "(unknown)"} ${installedAfter?.contentHash?.slice(0, 12) ?? "(no hash)"}.`,
  );

  let edgeRuntime: RemoteEdgeRuntimeStatus | null = await inspectRemoteEdgeRuntime(sshHost, { timeoutMs: timeoutPolicy.serviceMs }).catch((error) => {
    steps.fail("Edge runtime", sanitizeError(error));
    return null;
  });
  if (!edgeRuntime?.ok) {
    steps.fail("Edge runtime", edgeRuntime?.detail || "Dedicated edge-agent venv is not ready.");
    await restoreStoppedService();
    printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
  }
  steps.complete(
    "Edge runtime",
    `${edgeRuntime.pythonPath ?? "(unknown python)"} ${edgeRuntime.pythonVersion ?? ""} ${edgeRuntime.architecture ?? ""}; system site packages ${edgeRuntime.systemSitePackages ? "enabled" : "disabled"}; pigpio ${edgeRuntime.pigpioImport ? "importable" : "missing"}.`,
  );
  if (role === "greenhouse-node" && greenhouseSelection?.power?.provider === "kasa") {
    const wheelCopy = await copyEdgeWheelhouse(sshHost, edgeRuntime, { timeoutMs: timeoutPolicy.copyMs }).catch((error) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      status: 124,
    }));
    if (wheelCopy.status !== 0) {
      steps.fail("Edge wheelhouse", (wheelCopy.stderr.trim() || wheelCopy.stdout.trim() || "Could not copy compatible wheelhouse.").slice(0, 2000));
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    steps.complete("Edge wheelhouse", wheelCopy.stdout.trim() || "Remote wheelhouse preserved.");
  }

  // Verify the local `plantlab-edge` command is actually usable (Part 3) -
  // a plain non-interactive SSH command never sources ~/.profile, so this
  // checks a real login shell (bash -lc) rather than trusting PATH alone.
  const commandCheck = await verifyEdgeCommand(sshHost, inspection.remoteUser);
  if (commandCheck.resolvesInLoginShell) {
    steps.complete("Edge command", `plantlab-edge resolves on PATH in a login shell: ${commandCheck.resolvedPath}`);
  } else if (commandCheck.wrapperExists) {
    steps.complete("Edge command", `Installed at ${commandCheck.wrapperPath}. Reconnect your SSH session, or run: ${commandCheck.wrapperPath} doctor`);
  } else {
    steps.fail("Edge command", `plantlab-edge was not found at the expected path (${commandCheck.wrapperPath}) after install.`);
  }

  const registerInput = {
    name: sshHost,
    hostname: inspection.remoteHostname ?? sshHost,
    role,
    operatingSystem: inspection.operatingSystem,
    architecture: inspection.architecture,
    softwareVersion: null,
    coordinatorUrl,
    capabilities: registerCapabilities,
  };
  const credentialInput = {
    sshHost,
    // Unused for runtime: "python-edge" (only the "node" runtime branch of
    // rotateAndInstallCredential() reads repoPath, to run convergeNodeRole)
    // - kept non-empty only for readable diagnostics if it were ever logged.
    repoPath: "~/plantlab-edge-agent",
    coordinatorUrl,
    role,
    runtime: "python-edge" as const,
    nodeName: sshHost,
    remoteUser: inspection.remoteUser,
    registerInput,
    edgeConfig: greenhouseSelection
      ? {
          cameraEnabled: greenhouseSelection.cameraEnabled,
          sensors: greenhouseSelection.sensors,
          power: greenhouseSelection.power,
          disableSensors: greenhouseSelection.disableSensors,
          disablePower: greenhouseSelection.disablePower,
        }
      : { cameraEnabled: true },
    heartbeatTimeoutMs,
    waitForHeartbeat: false,
    deferEdgeRestart: true,
  };

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
    await restoreStoppedService();
    printAttachIncomplete(steps, sshHost);
    process.exitCode = 1;
    return;
  }
  if (!repair.ok) {
    await printEdgeAgentDiagnosis(sshHost);
    await restoreStoppedService();
    printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
  }

  if (repair.rotated) {
    console.log("✓ Previous credential revoked");
    console.log("✓ New credential installed securely");
  }
  if (greenhouseSelection?.shouldWriteSecrets && greenhouseSelection.secrets) {
    console.log("Writing Kasa credentials...");
    const secretWrite = await writeRemoteGreenhouseSecrets(sshHost, greenhouseSelection.secrets);
    if (secretWrite.status !== 0) {
      steps.fail("Greenhouse secrets", (secretWrite.stderr.trim() || "greenhouse.env write failed.").slice(0, 2000));
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    const secretStatus = await readRemoteGreenhouseSecretStatus(sshHost).catch(() => null);
    if (!secretStatus?.exists || secretStatus.mode !== "600" || !secretStatus.hasKasaUsername || !secretStatus.hasKasaPassword) {
      steps.fail("Greenhouse secrets", "Kasa credential file verification failed after write.");
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    steps.complete("Greenhouse secrets", "~/.config/plantlab/greenhouse.env written with owner-only permissions.");
    console.log("Credential file verified.");
  }

  if (role === "greenhouse-node" && registerCapabilities.includes("temperature") && registerCapabilities.includes("humidity")) {
    console.log("Checking DHT22 runtime backend...");
    let dht22 = await inspectRemoteDht22Support(sshHost, { timeoutMs: timeoutPolicy.serviceMs });
    for (const warning of dht22.warnings) console.log(`WARN: ${warning}`);
    if (!dht22.backendReady) {
      console.log(`DHT22 runtime backend: ${dht22.ok ? "missing" : "unknown"} (${dht22.detail})`);
      if (await confirmOrYes("Install or update DHT22 runtime support? [Y/n] ", options.yes, true)) {
        const installDht = await installRemoteDht22Support(sshHost, { timeoutMs: timeoutPolicy.installMs }).catch((error) => ({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          status: 124,
        }));
        if (installDht.status !== 0) {
          steps.fail("DHT22 backend", (installDht.stderr.trim() || installDht.stdout.trim() || "DHT22 backend installation failed.").slice(0, 2000));
          await restoreStoppedService();
          printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
          process.exitCode = 1;
          return;
        }
        dht22 = await inspectRemoteDht22Support(sshHost, { timeoutMs: timeoutPolicy.serviceMs });
      }
    }
    if (!dht22.backendReady) {
      steps.fail("DHT22 backend", dht22.detail || "DHT22 backend is not ready.");
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    steps.complete("DHT22 backend", `ready (${dht22.detail})`);

    const mode = dht22.selectedDriverMode ?? "unavailable";
    if (dht22.mockDropInEnabled || mode === "mock") {
      console.log("Mock greenhouse sensor mode is currently enabled.");
      if (await confirmOrYes("Switch this node to the real DHT22 driver? [Y/n] ", options.yes, true)) {
        const modeResult = await setRemoteGreenhouseSensorDriverMode(sshHost, "dht22", { timeoutMs: timeoutPolicy.serviceMs });
        if (modeResult.status !== 0) {
          steps.fail("Sensor driver mode", (modeResult.stderr.trim() || modeResult.stdout.trim() || "Could not switch sensor driver mode.").slice(0, 2000));
          await restoreStoppedService();
          printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
          process.exitCode = 1;
          return;
        }
        steps.complete("Sensor driver mode", "Switched from mock to dht22.");
      } else {
        steps.complete("Sensor driver mode", "Mock mode preserved by user choice.");
      }
    } else if (mode !== "dht22") {
      if (await confirmOrYes("Configure edge service to use real DHT22 driver? [Y/n] ", options.yes, true)) {
        const modeResult = await setRemoteGreenhouseSensorDriverMode(sshHost, "dht22", { timeoutMs: timeoutPolicy.serviceMs });
        if (modeResult.status !== 0) {
          steps.fail("Sensor driver mode", (modeResult.stderr.trim() || modeResult.stdout.trim() || "Could not set sensor driver mode.").slice(0, 2000));
          await restoreStoppedService();
          printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
          process.exitCode = 1;
          return;
        }
        steps.complete("Sensor driver mode", "Configured PLANTLAB_GREENHOUSE_SENSOR_DRIVER=dht22.");
      } else {
        steps.complete("Sensor driver mode", `Left unchanged (${mode}).`);
      }
    } else {
      steps.complete("Sensor driver mode", "Already dht22.");
    }
  } else if (role === "greenhouse-node") {
    steps.complete("DHT22 backend", "Skipped; no enabled DHT22 environmental sensors are configured.");
    steps.complete("Sensor driver mode", "Skipped.");
  }

  if (role === "greenhouse-node" && greenhouseSelection?.power?.provider === "kasa") {
    console.log("Checking Kasa power backend...");
    let kasa = await inspectRemoteKasaSupport(sshHost, { timeoutMs: timeoutPolicy.serviceMs });
    if (!kasa.dependencyAvailable || !kasa.pinnedCommitInstalled) {
      console.log(`Kasa runtime backend: ${kasa.pinStatus} (${kasa.detail})`);
      if (await confirmOrYes("Install or update Kasa runtime support? [Y/n] ", options.yes, true)) {
        const installKasa = await installRemoteKasaSupport(sshHost, { timeoutMs: timeoutPolicy.installMs }).catch((error) => ({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          status: 124,
        }));
        if (installKasa.status !== 0) {
          steps.fail("Kasa backend", (installKasa.stderr.trim() || installKasa.stdout.trim() || "Kasa backend installation failed.").slice(0, 2000));
          await restoreStoppedService();
          printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
          process.exitCode = 1;
          return;
        }
        kasa = await inspectRemoteKasaSupport(sshHost, { timeoutMs: timeoutPolicy.serviceMs });
      }
    }
    if (!kasa.dependencyAvailable || !kasa.pinnedCommitInstalled) {
      steps.fail("Kasa backend", `Pinned python-kasa dependency is not ready (${kasa.pinStatus}).`);
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    if (!kasa.credentialFilePresent || !kasa.credentialKeysPresent) {
      steps.fail("Kasa backend", "Kasa credential file is missing or incomplete.");
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    if (!kasa.probeReady) {
      steps.fail("Kasa backend", kasa.detail || "Kasa power probe did not verify configured outlets.");
      await restoreStoppedService();
      printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
      process.exitCode = 1;
      return;
    }
    steps.complete("Kasa backend", "Pinned python-kasa backend ready and configured outlets verified.");
  } else if (role === "greenhouse-node") {
    steps.complete("Kasa backend", "Skipped; Kasa power is not configured.");
  }

  console.log("Starting edge agent...");
  const heartbeatSince = new Date();
  const serviceStart = await startEdgeAgentService(sshHost, { timeoutMs: timeoutPolicy.serviceMs }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    status: 124,
  }));
  if (serviceStart.status !== 0) {
    steps.fail("Service start", (serviceStart.stderr.trim() || "Timed out starting plantlab-edge-agent.service.").slice(0, 2000));
    await restoreStoppedService();
    printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
  }
  serviceStarted = true;
  steps.complete("Service start", "plantlab-edge-agent.service started.");

  const heartbeat = await waitForNodeHeartbeat(prisma, repair.node.id, heartbeatSince, heartbeatTimeoutMs);
  if (!heartbeat) {
    steps.fail("Heartbeat", `No authenticated heartbeat received within ${Math.round(heartbeatTimeoutMs / 1000)} seconds.`);
    await printEdgeAgentDiagnosis(sshHost);
    printAttachIncomplete(steps, sshHost, `plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
  }
  console.log("Heartbeat received.");
  steps.complete("Heartbeat", "Agent heartbeat received");

  let inventory: Awaited<ReturnType<typeof waitForNodeInventory>> = [];
  if (registerCapabilities.includes("camera")) {
    const requestedInventory = await requestCameraInventoryRefresh(prisma, repair.node.name);
    const inventorySince = requestedInventory.inventoryRefreshRequestedAt ?? heartbeatSince;
    steps.complete("Camera inventory refresh", `Requested verified camera inventory at ${inventorySince.toISOString()}.`);
    console.log(timeoutPolicy.lowResource ? "Waiting for camera inventory from low-resource node..." : "Waiting for camera inventory...");
    inventory = await waitForNodeInventory(repair.node.id, inventorySince, inventoryTimeoutMs, {
      progressMs: 30_000,
      progressMessage: timeoutPolicy.lowResource ? "Still waiting; the node is healthy and enumerating video devices." : "Still waiting for camera inventory...",
    });
    if (inventory.length === 0) {
      steps.fail("Camera report", `No camera inventory was reported by the edge agent within ${Math.round(inventoryTimeoutMs / 1000)} seconds.`);
      printAttachIncomplete(steps, sshHost);
      process.exitCode = 1;
      return;
    }
    steps.complete("Camera report", `${inventory.length} camera(s) detected from active agent heartbeat`);
  } else {
    steps.complete("Camera report", "Skipped; camera support is not enabled for this greenhouse node.");
  }
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
  console.log(`Coordinator: ${coordinatorUrl}`);
  console.log(`Cameras detected: ${inventory.length}`);
  if (role === "greenhouse-node") console.log(`Capabilities: ${registerCapabilities.join(", ") || "(none)"}`);
  if (role === "greenhouse-node") {
    const secretStatus = await readRemoteGreenhouseSecretStatus(sshHost).catch(() => null);
    console.log(`Kasa credential file: ${secretStatus?.exists ? "present" : "missing"}`);
  }
  console.log("Remote agent: healthy");

  if (registerCapabilities.includes("camera") && (await confirmOptional("\nConfigure a camera now? [Y/n] ", options.yes, true))) {
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
    console.log(`${sshHost} node is ready.`);
    console.log(`Node: ${sshHost}`);
    console.log(`Coordinator: ${coordinatorUrl}`);
    console.log(`Camera: ${attached.camera.name ?? attached.camera.stableId}`);
    console.log(`Capture source: ${attached.captureSource.name}`);
    console.log("Agent: healthy");
  }
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
  "Coordinator discovery",
  "Role selection",
  "Greenhouse configuration",
  "Service stop",
  "Copy edge agent",
  "Install edge agent",
  "Edge command",
  "Credential",
  "Greenhouse secrets",
  "DHT22 backend",
  "Sensor driver mode",
  "Kasa backend",
  "Service start",
  "Heartbeat",
  "Camera inventory refresh",
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

function isTimeoutError(error: unknown): boolean {
  return /timed out|timeout/i.test(error instanceof Error ? error.message : String(error));
}

async function waitForInstallReconciliation(
  sshHost: string,
  sourceVersion: Awaited<ReturnType<typeof localEdgeAgentVersion>>,
  timeoutPolicy: EdgeAttachTimeoutPolicy,
): Promise<EdgeInstallReconciliation> {
  const started = Date.now();
  let lastProgressAt = started;
  let last = await reconcileEdgeAgentInstall(sshHost, sourceVersion, { timeoutMs: timeoutPolicy.ordinarySshMs });
  while (last.status === "still-running" && Date.now() - started < timeoutPolicy.installMs) {
    const now = Date.now();
    if (now - lastProgressAt >= 30_000) {
      console.log(`Remote install still running after ${Math.round((now - started) / 1000)} seconds...`);
      lastProgressAt = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    last = await reconcileEdgeAgentInstall(sshHost, sourceVersion, { timeoutMs: timeoutPolicy.ordinarySshMs });
  }
  return last;
}

function printInstallReconciliation(reconciled: EdgeInstallReconciliation): void {
  console.error("");
  console.error("Remote install reconciliation:");
  console.error(`- Status: ${reconciled.status}`);
  console.error(`- Detail: ${sanitizeText(reconciled.detail)}`);
  console.error(`- plantlab-edge executable: ${reconciled.executableExists ? "present" : "missing"}`);
  console.error(`- edge-agent config: ${reconciled.configExists ? "present" : "missing"}`);
  console.error(`- systemd unit: ${reconciled.unitExists ? "present" : "missing"}`);
  if (reconciled.installedVersion) {
    console.error(
      `- Installed version: ${reconciled.installedVersion.version ?? "(unknown)"} ${reconciled.installedVersion.contentHash?.slice(0, 12) ?? "(no hash)"}`,
    );
  }
  if (reconciled.service) {
    console.error(`- Service: ${reconciled.service.activeState ?? "(unknown)"}; enabled=${reconciled.service.enabledState ?? "(unknown)"}`);
  }
  if (reconciled.journal.length > 0) {
    console.error("Recent service output:");
    for (const line of reconciled.journal.slice(-6)) console.error(`  ${sanitizeText(line)}`);
  }
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

async function waitForNodeInventory(
  nodeId: string,
  since: Date,
  timeoutMs: number,
  options: { progressMs?: number; progressMessage?: string } = {},
) {
  const started = Date.now();
  let lastProgressAt = started;
  while (Date.now() - started < timeoutMs) {
    const cameras = await prisma.nodeCamera.findMany({ where: { nodeId, lastSeenAt: { gte: since } }, orderBy: { name: "asc" } });
    if (cameras.length > 0) return cameras;
    const now = Date.now();
    if (options.progressMs && options.progressMessage && now - lastProgressAt >= options.progressMs) {
      console.log(options.progressMessage);
      lastProgressAt = now;
    }
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
