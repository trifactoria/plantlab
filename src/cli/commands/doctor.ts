import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { formatBytes, runDoctorReport, runStorageAudit, applyStorageRemediation } from "../../lib/operations/doctor";
import { checkMigrationStatus } from "../../lib/operations/migrations";
import { computeNodeStatus, hasActiveCredential, markNodeStatus, registerOrRotateNode } from "../../lib/operations/nodeCredentials";
import {
  defaultCoordinatorUrl,
  diagnoseRemoteAgent,
  inspectRemoteHost,
  type RemoteAgentDiagnostics,
  validateSshHost,
} from "../../lib/operations/remoteNode";
import { convergeNodeRole } from "../../lib/operations/roleConvergence";
import { expectedServicesForRole, inappropriateServicesForRole, SERVICE_UNITS } from "../../lib/operations/serviceRoles";
import { buildQueryUnitStatesScript, classifyUnitState, isMaskedState, parseUnitStatesOutput } from "../../lib/operations/systemdUnits";
import { runRemoteShell } from "../../lib/operations/shellExec";
import { prisma } from "../../lib/prisma";
import { printDoctorReport } from "../format";

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command("doctor")
    .description("Structured health report: database, storage, camera, capture service, node status, backups")
    .option("--capture [device]", "Also capture one real temporary frame to verify the hardware path (not saved)")
    .option("--node <ssh-host>", "Run doctor on a remote node through SSH")
    .option("--fix", "Offer guided repairs for detected problems")
    .option("--yes", "Apply recommended repairs without prompting")
    .addHelpText(
      "after",
      `

Examples:
  plantlab doctor
  plantlab doctor --capture
  plantlab doctor --node xps
  plantlab doctor --node xps --fix
  plantlab doctor storage
`,
    )
    .action(async (options: { capture?: string | boolean; node?: string; fix?: boolean; yes?: boolean }) => {
      try {
        if (options.node) {
          validateSshHost(options.node);
          await runRemoteDoctor(options.node, { fix: options.fix, yes: options.yes });
          return;
        }
        const captureRequested = options.capture !== undefined;
        const captureDevice = typeof options.capture === "string" ? options.capture : null;

        const report = await runDoctorReport({ captureRequested, captureDevice });
        printDoctorReport(report);

        if (!report.summary.ok) {
          process.exitCode = 1;
        }
      } finally {
        await prisma.$disconnect();
      }
    });

  doctor
    .command("storage")
    .description("Detailed project-directory and ingest-staging audit, with optional remediation")
    .option("--remove-empty-orphans", "Delete qualifying empty orphan project directories (never non-empty, never symlinks)")
    .option("--remove-stale-ingest-files", "Delete stale leftover .partial ingest staging files")
    .option("--ignore-age", "Skip the safety-interval age check (explicit override only)")
    .option("--min-age-ms <ms>", "Override the default safety-interval age threshold", (v) => Number(v))
    .action(
      async (options: {
        removeEmptyOrphans?: boolean;
        removeStaleIngestFiles?: boolean;
        ignoreAge?: boolean;
        minAgeMs?: number;
      }) => {
        try {
          const report = await runStorageAudit({ minAgeMs: options.minAgeMs });
          const { projectDirectories, ingestFiles } = report;

          console.log(`Data root: ${projectDirectories.dataRoot}`);
          console.log(`Projects data directory: ${projectDirectories.projectsDataDir}`);
          console.log(`Database projects: ${projectDirectories.totalDbProjects}`);
          console.log(`Existing directories on disk: ${projectDirectories.existingDirectoryNames.length}`);
          console.log("");

          if (projectDirectories.missingExpectedDirectories.length > 0) {
            console.log(
              `Projects with no directory on disk yet (${projectDirectories.missingExpectedDirectories.length}) - normal until their first capture/upload:`,
            );
            for (const missing of projectDirectories.missingExpectedDirectories) {
              console.log(`  ${missing.projectId} -> ${missing.directoryPath}`);
            }
            console.log("");
          }

          console.log(`Empty orphan directories: ${projectDirectories.emptyOrphans.length}`);
          for (const orphan of projectDirectories.emptyOrphans) {
            console.log(`  ${orphan.directoryPath} (mtime ${orphan.mtime.toISOString()})`);
          }
          console.log("");

          if (projectDirectories.nonEmptyOrphans.length > 0) {
            console.log(`NON-EMPTY orphan directories (${projectDirectories.nonEmptyOrphans.length}) - never auto-deleted, inspect manually:`);
            for (const orphan of projectDirectories.nonEmptyOrphans) {
              console.log(`  ${orphan.directoryPath} - files: ${orphan.fileCount}, size: ${formatBytes(orphan.totalBytes)}, mtime: ${orphan.mtime.toISOString()}`);
            }
            console.log("");
          }

          if (projectDirectories.malformedNames.length > 0) {
            console.log(`Malformed/unexpected directory names (${projectDirectories.malformedNames.length}):`);
            for (const entry of projectDirectories.malformedNames) {
              console.log(`  ${entry.directoryPath}`);
            }
            console.log("");
          }

          if (projectDirectories.symlinks.length > 0) {
            console.log(`Symlinks under the projects data directory (${projectDirectories.symlinks.length}) - always preserved:`);
            for (const entry of projectDirectories.symlinks) {
              console.log(`  ${entry.directoryPath}`);
            }
            console.log("");
          }

          console.log("---");
          console.log(`Ingest staging directory: ${ingestFiles.ingestDir}`);
          console.log(`Stale .partial ingest files: ${ingestFiles.staleFiles.length} (${formatBytes(ingestFiles.totalStaleBytes)})`);
          for (const file of ingestFiles.staleFiles) {
            console.log(`  ${file.filePath} (${formatBytes(file.byteSize)}, mtime ${file.mtime.toISOString()})`);
          }
          if (ingestFiles.recentFiles.length > 0) {
            console.log(`Recent .partial ingest files (likely in-flight, never touched): ${ingestFiles.recentFiles.length}`);
          }
          console.log("");

          if (!options.removeEmptyOrphans && !options.removeStaleIngestFiles) {
            console.log(
              "Dry run only - nothing was deleted. Re-run with --remove-empty-orphans and/or --remove-stale-ingest-files to clean up qualifying items.",
            );
            return;
          }

          const remediation = await applyStorageRemediation(report, {
            removeEmptyOrphans: options.removeEmptyOrphans,
            removeStaleIngestFiles: options.removeStaleIngestFiles,
            ignoreAge: options.ignoreAge,
            minAgeMs: options.minAgeMs,
          });

          if (remediation.emptyOrphans) {
            console.log(`Removed ${remediation.emptyOrphans.removed.length} empty orphan director${remediation.emptyOrphans.removed.length === 1 ? "y" : "ies"}.`);
            for (const skip of remediation.emptyOrphans.skipped) {
              console.log(`  skipped ${skip.directoryPath}: ${skip.reason}`);
            }
          }
          if (remediation.staleIngestFiles) {
            console.log(`Removed ${remediation.staleIngestFiles.removed.length} stale ingest file(s).`);
            for (const skip of remediation.staleIngestFiles.skipped) {
              console.log(`  skipped ${skip.filePath}: ${skip.reason}`);
            }
          }
        } finally {
          await prisma.$disconnect();
        }
      },
    );
}

/**
 * Correlates the remote inspection with the coordinator's own PlantLabNode
 * record (Part 12: "Doctor should be able to correlate: coordinator node
 * record, remote hostname, remote config, credential state, last
 * heartbeat") so a partially-enrolled node is recognized as such even when
 * the remote's own local config is incomplete or wasn't written for some
 * reason (Part 4) - the coordinator's recorded role/credential state is
 * treated as at least as authoritative as whatever the remote machine's
 * own plantlab.config.json currently says.
 */
async function loadCoordinatorRecord(sshHost: string) {
  const node = await prisma.plantLabNode.findUnique({ where: { name: sshHost } });
  if (!node) return null;
  const activeCredential = await hasActiveCredential(prisma, node.id);
  return { node, activeCredential, status: computeNodeStatus(node, activeCredential) };
}

async function queryRemoteAgentUnitState(sshHost: string) {
  const script = buildQueryUnitStatesScript(["plantlab-agent.service", "plantlab-web.service", "plantlab-camera.service"]);
  const result = await runRemoteShell(sshHost, script).catch(() => null);
  return result ? parseUnitStatesOutput(result.stdout) : [];
}

async function runRemoteDoctor(sshHost: string, options: { fix?: boolean; yes?: boolean }): Promise<void> {
  const inspection = await inspectRemoteHost(sshHost);
  const repoPath = inspection.repoPath;
  const coordinatorRecord = await loadCoordinatorRecord(sshHost);
  // The intended role: prefer what the remote itself reports, but fall
  // back to the coordinator's recorded intent when the remote's own config
  // is missing/incomplete - see the doc comment above.
  const intendedRole = inspection.role || coordinatorRecord?.node.role || null;

  const problems: string[] = [];
  const repairs: string[] = [];

  if (!repoPath) {
    console.log("Problems detected:");
    console.log("1. PlantLab repository was not found on the remote node.");
    console.log("");
    console.log("Recommended repairs:");
    console.log("1. Clone or install PlantLab on the remote node before attaching it.");
    process.exitCode = 1;
    return;
  }

  let diagnostics: RemoteAgentDiagnostics | null = null;
  try {
    diagnostics = await diagnoseRemoteAgent(sshHost, repoPath);
  } catch (error) {
    problems.push(`Agent diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const unitStates = await queryRemoteAgentUnitState(sshHost);
  const agentUnit = unitStates.find((s) => s.id === "plantlab-agent.service");

  if (intendedRole === "camera-node") {
    const expected = expectedServicesForRole("camera-node");
    const inappropriateActive = inappropriateServicesForRole("camera-node")
      .map((service) => ({ service, unit: SERVICE_UNITS[service] }))
      .filter(({ unit }) => unitStates.find((s) => s.id === unit)?.activeState === "active");

    if (agentUnit && isMaskedState(agentUnit)) {
      problems.push(`Required unit plantlab-agent.service is masked (state: ${classifyUnitState(agentUnit)}).`);
      repairs.push("Unmask plantlab-agent.service.");
    }
    if (!inspection.role) {
      problems.push(coordinatorRecord ? "Remote role configuration is missing or incomplete (coordinator has a pending enrollment record)." : "Node role is not configured.");
      repairs.push("Rewrite camera-node configuration.");
    }
    if (coordinatorRecord) {
      problems.push(`Coordinator enrollment exists: ${coordinatorRecord.node.role} (${coordinatorRecord.status}).`);
    } else {
      problems.push("No coordinator enrollment record exists for this node yet.");
      repairs.push("Register this node with the coordinator.");
    }
    if (!diagnostics?.credentialExists) {
      problems.push("Agent credential file is missing.");
      repairs.push("Create/fix the agent credential file.");
    } else if (diagnostics.credentialMode !== "600" || diagnostics.credentialDirMode !== "700") {
      problems.push(`Agent credential permissions are ${diagnostics.credentialMode ?? "unknown"}/${diagnostics.credentialDirMode ?? "unknown"}, expected 0600/0700.`);
      repairs.push("Rewrite the credential file with restrictive permissions.");
    }
    if (!diagnostics?.spoolWritable) {
      problems.push("Agent spool root is missing or not writable.");
      repairs.push("Create/fix the agent spool directory.");
    }
    if (diagnostics?.coordinatorReachable === false) {
      problems.push(`Coordinator is unreachable from the node: ${diagnostics.coordinatorUrl ?? "(not configured)"}.`);
    }
    for (const { unit } of inappropriateActive) {
      problems.push(`${unit} is active but should be stopped for camera-node role.`);
      repairs.push(`Stop ${unit}.`);
    }
    if (!agentUnit || agentUnit.activeState !== "active") {
      problems.push(`plantlab-agent.service is ${agentUnit ? classifyUnitState(agentUnit) : "not installed"}.`);
      repairs.push("Install/update the agent unit and start it.");
    }
    if (coordinatorRecord && coordinatorRecord.status !== "active") {
      problems.push(`Node status is "${coordinatorRecord.status}" (no recent heartbeat).`);
      repairs.push("Restart the agent and wait for a heartbeat.");
    }
    if (inspection.cameras.length === 0) {
      problems.push("No camera inventory has been reported.");
    }

    if (problems.length === 0) {
      console.log(`Remote node ${sshHost} looks healthy for role camera-node.`);
      return;
    }

    console.log("Problems detected:");
    problems.forEach((problem, index) => console.log(`${index + 1}. ${problem}`));
    console.log("");
    console.log("Recommended repairs:");
    Array.from(new Set(repairs)).forEach((repair, index) => console.log(`${index + 1}. ${repair}`));

    if (!options.fix) {
      process.exitCode = 1;
      return;
    }

    console.log("");
    const coordinatorUrl = diagnostics?.coordinatorUrl || inspection.coordinatorUrl || coordinatorRecord?.node.coordinatorUrl || defaultCoordinatorUrl();

    // convergeNodeRole() performs these together as one interdependent
    // operation (you cannot sensibly install/start the agent unit without
    // also unmasking it if masked, or without the config it reads on
    // startup) - each question is asked individually for visibility and
    // control per DEPLOYMENT.md "doctor --fix checklist", but any "yes"
    // triggers the same underlying convergence.
    const confirmations = [
      await confirmOrYes("Unmask agent service? [Y/n] ", options.yes),
      await confirmOrYes("Rewrite camera-node configuration? [Y/n] ", options.yes),
      await confirmOrYes("Create/fix spool directory? [Y/n] ", options.yes),
      await confirmOrYes("Stop web service? [Y/n] ", options.yes),
      await confirmOrYes("Stop camera service? [Y/n] ", options.yes),
      await confirmOrYes("Install/update agent unit? [Y/n] ", options.yes),
      await confirmOrYes("Restart agent? [Y/n] ", options.yes),
    ];
    const waitForHeartbeat = await confirmOrYes("Wait for heartbeat? [Y/n] ", options.yes);

    if (!confirmations.some(Boolean)) {
      console.log("No repairs applied.");
      return;
    }

    const needsCredentialRepair = !diagnostics?.credentialExists || diagnostics.credentialMode !== "600" || diagnostics.credentialDirMode !== "700";
    let registered: Awaited<ReturnType<typeof registerOrRotateNode>> | null = null;
    try {
      registered = await registerOrRotateNode(prisma, {
        name: sshHost,
        hostname: inspection.remoteHostname ?? sshHost,
        role: "camera-node",
        operatingSystem: inspection.operatingSystem,
        architecture: inspection.architecture,
        softwareVersion: inspection.plantLabVersion,
        coordinatorUrl,
        rotateCredential: needsCredentialRepair,
      });
    } catch (error) {
      console.error(`Coordinator registration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }

    const heartbeatSince = new Date();
    const convergence = await convergeNodeRole({
      target: { kind: "remote", sshHost, repoPath },
      role: "camera-node",
      coordinatorUrl,
      nodeName: sshHost,
      spoolRoot: diagnostics?.spoolRoot || `/home/${inspection.remoteUser ?? sshHost}/.local/state/plantlab-agent`,
      credential: registered.credential || null,
      startServices: true,
      remoteUser: inspection.remoteUser,
    });

    for (const step of convergence.steps) {
      console.log(`${step.status === "failed" ? "FAIL" : step.status === "skipped" ? "SKIP" : "PASS"}: ${step.name}: ${step.detail}`);
    }

    if (!convergence.ok) {
      await markNodeStatus(prisma, registered.node.id, "repair-required");
      console.error("");
      console.error(`Repair did not fully succeed. Safe to retry: ${convergence.retryCommand}`);
      process.exitCode = 1;
      return;
    }

    if (waitForHeartbeat) {
      console.log("Waiting for heartbeat...");
      const started = Date.now();
      let heartbeat = false;
      while (Date.now() - started < 45_000) {
        const node = await prisma.plantLabNode.findUnique({ where: { id: registered.node.id }, select: { lastHeartbeatAt: true } });
        if (node?.lastHeartbeatAt && node.lastHeartbeatAt >= heartbeatSince) {
          heartbeat = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!heartbeat) {
        await markNodeStatus(prisma, registered.node.id, "repair-required");
        console.error("No heartbeat received within 45 seconds - the repair may not be fully effective yet.");
        process.exitCode = 1;
        return;
      }
      await markNodeStatus(prisma, registered.node.id, "pending");
      console.log("PASS: Heartbeat received.");
    }

    console.log("");
    console.log(`Repair actions completed. Re-run: plantlab doctor --node ${sshHost}`);
    return;
  }

  if (intendedRole && intendedRole !== "camera-node") {
    const schemaCheck = await checkMigrationStatus().catch((error) => ({
      current: false,
      detail: error instanceof Error ? error.message : String(error),
      pendingMigrations: [] as string[],
    }));
    if (!schemaCheck.current) {
      problems.push(`Local database schema is stale: ${schemaCheck.detail}`);
      repairs.push("Run: plantlab update (applies pending migrations after a backup).");
    }
  }
  problems.push(intendedRole ? `Node role is ${intendedRole}; remote camera attachment expects camera-node.` : "Node role is not configured.");
  repairs.push(`Run: plantlab node attach ${sshHost}`);

  console.log("Problems detected:");
  problems.forEach((problem, index) => console.log(`${index + 1}. ${problem}`));
  console.log("");
  console.log("Recommended repairs:");
  Array.from(new Set(repairs)).forEach((repair, index) => console.log(`${index + 1}. ${repair}`));
  process.exitCode = 1;
}

async function confirmOrYes(question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error("Refusing to repair without confirmation. Re-run with --yes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return !answer || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
