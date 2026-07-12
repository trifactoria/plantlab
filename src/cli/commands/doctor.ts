import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { formatBytes, runDoctorReport, runStorageAudit, applyStorageRemediation } from "../../lib/operations/doctor";
import { registerOrRotateNode } from "../../lib/operations/nodeCredentials";
import {
  applyRemoteServiceRole,
  configureRemoteAgent,
  defaultCoordinatorUrl,
  diagnoseRemoteAgent,
  inspectRemoteHost,
  type RemoteAgentDiagnostics,
  validateSshHost,
} from "../../lib/operations/remoteNode";
import { expectedServicesForRole, inappropriateServicesForRole } from "../../lib/operations/serviceRoles";
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

async function runRemoteDoctor(sshHost: string, options: { fix?: boolean; yes?: boolean }): Promise<void> {
  const inspection = await inspectRemoteHost(sshHost);
  const role = inspection.role ?? "not configured";
  const repoPath = inspection.repoPath;
  const problems: string[] = [];
  const repairs: string[] = [];

  let diagnostics: RemoteAgentDiagnostics | null = null;
  if (repoPath) {
    try {
      diagnostics = await diagnoseRemoteAgent(sshHost, repoPath);
    } catch (error) {
      problems.push(`Agent diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
      repairs.push(`Re-run: plantlab node attach ${sshHost}`);
    }
  } else {
    problems.push("PlantLab repository was not found on the remote node.");
    repairs.push("Clone or install PlantLab on the remote node before attaching it.");
  }

  if (inspection.role === "camera-node") {
    const expected = expectedServicesForRole("camera-node");
    const inappropriate = inappropriateServicesForRole("camera-node").filter((service) => inspection.services[service] === "active");
    if (diagnostics?.agentStatus !== "active") {
      problems.push(`Agent service is ${diagnostics?.agentStatus ?? inspection.services.agent ?? "unknown"}.`);
      repairs.push("Restart plantlab-agent.service.");
    }
    if (!diagnostics?.credentialExists) {
      problems.push("Agent credential file is missing.");
      repairs.push("Create or repair the agent credential file.");
    } else if (diagnostics.credentialMode !== "600" || diagnostics.credentialDirMode !== "700") {
      problems.push(`Agent credential permissions are ${diagnostics.credentialMode ?? "unknown"}/${diagnostics.credentialDirMode ?? "unknown"}, expected 0600/0700.`);
      repairs.push("Rewrite the credential file with restrictive permissions.");
    }
    if (diagnostics?.coordinatorReachable === false) {
      problems.push(`Coordinator is unreachable from the node: ${diagnostics.coordinatorUrl ?? "(not configured)"}.`);
      repairs.push("Verify the coordinator URL and network reachability.");
    }
    for (const service of inappropriate) {
      problems.push(`${service} service is running but should be stopped for camera-node role.`);
    }
    if (inappropriate.length > 0) {
      repairs.push(`Stop inappropriate services; expected service(s): ${expected.join(", ")}.`);
    }
    if (inspection.cameras.length === 0) {
      problems.push("No camera inventory has been reported by inspection.");
      repairs.push("Restart the agent and refresh camera inventory.");
    }
  } else if (inspection.role && inspection.role !== "camera-node") {
    problems.push(`Node role is ${inspection.role}; remote camera attachment expects camera-node.`);
    repairs.push(`Run: plantlab node attach ${sshHost}`);
  } else {
    problems.push("Node role is not configured.");
    repairs.push(`Run: plantlab node attach ${sshHost}`);
  }

  if (problems.length === 0) {
    console.log(`Remote node ${sshHost} looks healthy for role ${role}.`);
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
  if (!repoPath) {
    process.exitCode = 1;
    return;
  }

  console.log("");
  if (inspection.role === "camera-node" && diagnostics) {
    const needsCredentialRepair =
      !diagnostics.credentialExists || diagnostics.credentialMode !== "600" || diagnostics.credentialDirMode !== "700";
    if (needsCredentialRepair && (await confirmOrYes("Create or repair agent credential file? [Y/n] ", options.yes))) {
      const registered = await registerOrRotateNode(prisma, {
        name: sshHost,
        hostname: inspection.remoteHostname ?? sshHost,
        role: "camera-node",
        operatingSystem: inspection.operatingSystem,
        architecture: inspection.architecture,
        softwareVersion: inspection.plantLabVersion,
        coordinatorUrl: diagnostics.coordinatorUrl ?? inspection.coordinatorUrl ?? defaultCoordinatorUrl(),
        rotateCredential: true,
      });
      const configured = await configureRemoteAgent({
        sshHost,
        repoPath,
        nodeName: sshHost,
        coordinatorUrl: diagnostics.coordinatorUrl ?? inspection.coordinatorUrl ?? defaultCoordinatorUrl(),
        credential: registered.credential,
        spoolRoot: diagnostics.spoolRoot ?? `/home/${inspection.remoteUser ?? sshHost}/.local/state/plantlab-agent`,
        startService: false,
      });
      if (configured.status !== 0) {
        console.error(configured.stderr.trim() || "Credential repair failed.");
        process.exitCode = 1;
        return;
      }
      console.log("PASS: Agent credential file repaired.");
    }

    if (await confirmOrYes("Stop inappropriate services and restart the agent service? [Y/n] ", options.yes)) {
      const result = await applyRemoteServiceRole(sshHost, "camera-node");
      if (result.status !== 0) {
        console.error(result.stderr.trim() || "Service repair failed.");
        process.exitCode = 1;
        return;
      }
      console.log("PASS: camera-node services repaired.");
    }
  } else {
    console.log(`Run this conversion flow instead: plantlab node attach ${sshHost}`);
    process.exitCode = 1;
    return;
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
