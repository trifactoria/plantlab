import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { formatBytes, runDoctorReport, runStorageAudit, applyStorageRemediation } from "../../lib/operations/doctor";
import { checkMigrationStatus } from "../../lib/operations/migrations";
import { computeNodeStatus, hasActiveCredential } from "../../lib/operations/nodeCredentials";
import { probeRemoteCredential, rotateAndInstallCredential } from "../../lib/operations/credentialRepair";
import { diagnoseEdgeAgent, type EdgeAgentDiagnostics } from "../../lib/operations/edgeAgentDiagnostics";
import {
  defaultCoordinatorUrl,
  diagnoseRemoteAgent,
  inspectRemoteHost,
  type RemoteAgentDiagnostics,
  validateSshHost,
} from "../../lib/operations/remoteNode";
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
  // The intended runtime (Part 13): prefer what the coordinator's own
  // record last heard from a real heartbeat (authoritative once a node has
  // ever attached), falling back to the hardware feasibility check for a
  // node that has never attached yet - inspection.role/repoPath are almost
  // always null for a Pi-Zero-class node (no full repo clone, no
  // plantlab.config.json to read - see remoteNode.ts INSPECT_SCRIPT), so
  // this must not depend on either.
  const intendedRuntime: "node" | "python-edge" =
    (coordinatorRecord?.node.runtime as "node" | "python-edge" | null) || (inspection.fullAgentSupported ? "node" : "python-edge");

  const problems: string[] = [];
  const repairs: string[] = [];

  if (intendedRuntime === "python-edge") {
    await runEdgeAgentDoctor(sshHost, inspection, coordinatorRecord, options);
    return;
  }

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

  if (intendedRole === "camera-node" || intendedRole === "greenhouse-node") {
    const expected = expectedServicesForRole(intendedRole);
    const inappropriateActive = inappropriateServicesForRole(intendedRole)
      .map((service) => ({ service, unit: SERVICE_UNITS[service] }))
      .filter(({ unit }) => unitStates.find((s) => s.id === unit)?.activeState === "active");

    const coordinatorUrl = diagnostics?.coordinatorUrl || inspection.coordinatorUrl || coordinatorRecord?.node.coordinatorUrl || defaultCoordinatorUrl();

    // Real authenticated probe against the coordinator (Part 1), not just
    // file existence/permissions - see credentialRepair.ts for why (the
    // real bokchoy failure: a credential file existed with correct
    // permissions but unusable content).
    const probe = await probeRemoteCredential({ sshHost, coordinatorUrl, remoteUser: inspection.remoteUser });
    const needsCredentialRepair = probe.status !== "valid" && probe.status !== "unknown";

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
    if (needsCredentialRepair) {
      problems.push(`Agent credential is not demonstrably valid: ${probe.detail}`);
      repairs.push("Rotate node credential.");
    } else if (probe.status === "unknown") {
      problems.push(`Agent credential validity could not be verified: ${probe.detail}`);
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
      console.log(`Remote node ${sshHost} looks healthy for role ${intendedRole}.`);
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

    // convergeNodeRole() (invoked inside rotateAndInstallCredential())
    // performs these together as one interdependent operation (you cannot
    // sensibly install/start the agent unit without also unmasking it if
    // masked, or without the config it reads on startup) - each question is
    // asked individually for visibility and control per DEPLOYMENT.md
    // "doctor --fix checklist", but any "yes" triggers the same underlying
    // convergence.
    const confirmations = [
      await confirmOrYes("Unmask agent service? [Y/n] ", options.yes),
      await confirmOrYes("Rewrite camera-node configuration? [Y/n] ", options.yes),
      await confirmOrYes("Create/fix spool directory? [Y/n] ", options.yes),
      await confirmOrYes("Stop web service? [Y/n] ", options.yes),
      await confirmOrYes("Stop camera service? [Y/n] ", options.yes),
      await confirmOrYes("Install/update agent unit? [Y/n] ", options.yes),
      needsCredentialRepair ? await confirmOrYes("Rotate node credential? [Y/n] ", options.yes) : false,
      await confirmOrYes("Restart agent? [Y/n] ", options.yes),
    ];
    const waitForHeartbeat = await confirmOrYes("Wait for heartbeat? [Y/n] ", options.yes);

    if (!confirmations.some(Boolean)) {
      console.log("No repairs applied.");
      return;
    }

    const rotate = needsCredentialRepair && confirmations[6];
    if (rotate) {
      console.log("");
      console.log(`Existing node credential is ${probe.status === "missing" ? "missing" : probe.status === "rejected" ? "rejected by the coordinator" : "not valid"}.`);
      console.log("Rotating credential automatically...");
    }

    const repair = await rotateAndInstallCredential(prisma, {
      sshHost,
      repoPath,
      coordinatorUrl,
      role: intendedRole,
      runtime: "node",
      nodeName: sshHost,
      spoolRoot: diagnostics?.spoolRoot || `/home/${inspection.remoteUser ?? sshHost}/.local/state/plantlab-agent`,
      remoteUser: inspection.remoteUser,
      registerInput: {
        name: sshHost,
        hostname: inspection.remoteHostname ?? sshHost,
        role: intendedRole,
        operatingSystem: inspection.operatingSystem,
        architecture: inspection.architecture,
        softwareVersion: inspection.plantLabVersion,
        coordinatorUrl,
      },
      waitForHeartbeat,
      rotate,
      forceRestart: confirmations[7],
    });

    for (const step of repair.steps) {
      console.log(`${step.status === "failed" ? "FAIL" : step.status === "skipped" ? "SKIP" : "PASS"}: ${step.name}: ${step.detail}`);
    }

    if (!repair.ok) {
      console.error("");
      console.error(`Repair did not fully succeed. Safe to retry: plantlab doctor --node ${sshHost} --fix`);
      process.exitCode = 1;
      return;
    }

    if (rotate) {
      console.log("");
      console.log("✓ Previous credential revoked");
      console.log("✓ New credential installed securely");
      console.log("✓ Agent restarted");
      if (waitForHeartbeat) console.log("✓ Authenticated heartbeat received");
    }

    console.log("");
    console.log(`Repair actions completed. Re-run: plantlab doctor --node ${sshHost}`);
    return;
  }

  if (intendedRole) {
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
  problems.push(intendedRole ? `Node role is ${intendedRole}; remote camera attachment expects camera-node or greenhouse-node.` : "Node role is not configured.");
  repairs.push(`Run: plantlab node attach ${sshHost}`);

  console.log("Problems detected:");
  problems.forEach((problem, index) => console.log(`${index + 1}. ${problem}`));
  console.log("");
  console.log("Recommended repairs:");
  Array.from(new Set(repairs)).forEach((repair, index) => console.log(`${index + 1}. ${repair}`));
  process.exitCode = 1;
}

/**
 * The Python edge-agent counterpart of the camera-node branch above (Part
 * 13) - runtime/agent version/protocol version/credential validity/
 * heartbeat/camera inventory/spool health/disk/memory usage/last capture,
 * with automatic credential repair via the exact same
 * rotateAndInstallCredential() lifecycle (runtime: "python-edge"). Never
 * requires a full repository clone on the remote node - see
 * edgeAgentDiagnostics.ts.
 */
async function runEdgeAgentDoctor(
  sshHost: string,
  inspection: Awaited<ReturnType<typeof inspectRemoteHost>>,
  coordinatorRecord: Awaited<ReturnType<typeof loadCoordinatorRecord>>,
  options: { fix?: boolean; yes?: boolean },
): Promise<void> {
  const problems: string[] = [];
  const repairs: string[] = [];

  const coordinatorUrl = inspection.coordinatorUrl || coordinatorRecord?.node.coordinatorUrl || defaultCoordinatorUrl();

  let diagnostics: EdgeAgentDiagnostics | null = null;
  try {
    diagnostics = await diagnoseEdgeAgent(sshHost);
  } catch (error) {
    problems.push(`Edge agent diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const probe = await probeRemoteCredential({ sshHost, coordinatorUrl, remoteUser: inspection.remoteUser });
  const needsCredentialRepair = probe.status !== "valid" && probe.status !== "unknown";

  if (!diagnostics?.edgeAgentDirExists) {
    problems.push("~/plantlab-edge-agent was not found on the remote node.");
    repairs.push(`Install the edge agent: plantlab node attach ${sshHost}`);
  }
  if (!diagnostics?.configExists) {
    problems.push(coordinatorRecord ? "Remote edge-agent configuration is missing or incomplete (coordinator has a pending enrollment record)." : "Node role is not configured.");
    repairs.push("Rewrite edge-agent configuration.");
  }
  if (coordinatorRecord) {
    problems.push(`Coordinator enrollment exists: ${coordinatorRecord.node.role} (${coordinatorRecord.status}), agent version ${coordinatorRecord.node.softwareVersion ?? "(unknown)"}, protocol ${coordinatorRecord.node.protocolVersion ?? "(unknown)"}.`);
  } else {
    problems.push("No coordinator enrollment record exists for this node yet.");
    repairs.push("Register this node with the coordinator.");
  }
  if (needsCredentialRepair) {
    problems.push(`Agent credential is not demonstrably valid: ${probe.detail}`);
    repairs.push("Rotate node credential.");
  } else if (probe.status === "unknown") {
    problems.push(`Agent credential validity could not be verified: ${probe.detail}`);
  }
  if (diagnostics && !diagnostics.spoolWritable) {
    problems.push("Agent spool root is missing or not writable.");
    repairs.push("Create/fix the agent spool directory.");
  }
  if (diagnostics && !diagnostics.ffmpegAvailable) {
    problems.push("ffmpeg is missing on the remote node.");
    repairs.push("Install ffmpeg: sudo apt-get install -y ffmpeg");
  }
  if (diagnostics && diagnostics.unitStatus !== "active") {
    problems.push(`plantlab-edge-agent.service is ${diagnostics.unitStatus || "not installed"}.`);
    repairs.push("Restart the edge agent.");
  }
  if (coordinatorRecord && coordinatorRecord.status !== "active") {
    problems.push(`Node status is "${coordinatorRecord.status}" (no recent heartbeat).`);
    repairs.push("Restart the agent and wait for a heartbeat.");
  }

  console.log(`Runtime: python-edge`);
  if (diagnostics) {
    console.log(`Python: ${diagnostics.pythonVersion ?? "(unknown)"}`);
    console.log(`Disk free: ${diagnostics.diskFree ?? "(unknown)"}`);
    console.log(`Memory: ${diagnostics.memoryTotalMb !== null ? `${diagnostics.memoryTotalMb} MB` : "(unknown)"}${diagnostics.memoryAvailableMb !== null ? ` (${diagnostics.memoryAvailableMb} MB available)` : ""}`);
    console.log(`Spool: ${diagnostics.spoolRoot ?? "(unknown)"}${diagnostics.spoolSizeBytes !== null ? ` (${formatBytes(diagnostics.spoolSizeBytes)})` : ""}`);
  }
  console.log("");

  if (problems.length === 0) {
    console.log(`Remote node ${sshHost} looks healthy (runtime: python-edge).`);
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

  if (!diagnostics?.edgeAgentDirExists) {
    console.error("");
    console.error(`Cannot auto-repair: the edge agent isn't installed on ${sshHost} yet. Run: plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  const rotateConfirm = needsCredentialRepair ? await confirmOrYes("Rotate node credential? [Y/n] ", options.yes) : false;
  const restartConfirm = await confirmOrYes("Restart edge agent? [Y/n] ", options.yes);
  const waitForHeartbeat = await confirmOrYes("Wait for heartbeat? [Y/n] ", options.yes);

  if (!rotateConfirm && !restartConfirm) {
    console.log("No repairs applied.");
    return;
  }

  const rotate = needsCredentialRepair && rotateConfirm;
  if (rotate) {
    console.log("");
    console.log(`Existing node credential is ${probe.status === "missing" ? "missing" : probe.status === "rejected" ? "rejected by the coordinator" : "not valid"}.`);
    console.log("Rotating credential automatically...");
  }

  const fallbackRole: "camera-node" | "greenhouse-node" = coordinatorRecord?.node.role === "camera-node" ? "camera-node" : "greenhouse-node";
  const repair = await rotateAndInstallCredential(prisma, {
    sshHost,
    repoPath: "~/plantlab-edge-agent",
    coordinatorUrl,
    role: fallbackRole,
    runtime: "python-edge",
    nodeName: sshHost,
    remoteUser: inspection.remoteUser,
    registerInput: {
      name: sshHost,
      hostname: inspection.remoteHostname ?? sshHost,
      role: fallbackRole,
      operatingSystem: inspection.operatingSystem,
      architecture: inspection.architecture,
      softwareVersion: coordinatorRecord?.node.softwareVersion ?? null,
      coordinatorUrl,
    },
    waitForHeartbeat,
    rotate,
    forceRestart: restartConfirm,
  });

  for (const step of repair.steps) {
    console.log(`${step.status === "failed" ? "FAIL" : step.status === "skipped" ? "SKIP" : "PASS"}: ${step.name}: ${step.detail}`);
  }

  if (!repair.ok) {
    console.error("");
    console.error(`Repair did not fully succeed. Safe to retry: plantlab doctor --node ${sshHost} --fix`);
    process.exitCode = 1;
    return;
  }

  if (rotate) {
    console.log("");
    console.log("✓ Previous credential revoked");
    console.log("✓ New credential installed securely");
    console.log("✓ Agent restarted");
    if (waitForHeartbeat) console.log("✓ Authenticated heartbeat received");
  }

  console.log("");
  console.log(`Repair actions completed. Re-run: plantlab doctor --node ${sshHost}`);
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
