import { existsSync } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  auditProjectDirectories,
  auditStaleIngestFiles,
  DEFAULT_MIN_ORPHAN_AGE_MS,
  DEFAULT_STALE_INGEST_AGE_MS,
  formatBytes,
  removeEmptyOrphans,
  removeStaleIngestFiles,
  type IngestStagingReport,
  type ProjectDirectoryReport,
  type RemoveEmptyOrphansResult,
  type RemoveStaleIngestFilesResult,
} from "../dataDoctor.server";
import { listBackups } from "../backup";
import { resolveAllPaths, resolveRootDir, resolveSqliteDatabasePath, type ResolvedPlantLabPaths } from "../paths.server";
import { prisma } from "../prisma";
import { getServiceStatusSnapshot } from "../serviceStatus";
import {
  checkCameraGroupMembership,
  checkDatabaseConnectivity,
  checkExecutable,
  checkVideoDevices,
  checkWritableDirectory,
  type CheckResult,
} from "../startupChecks";
import { readNodeConfig } from "./config";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/operations/doctor.ts touches the filesystem and process environment - it must never be imported from a Client Component or run in a browser.",
  );
}

/**
 * The single shared health-check service. `plantlab doctor` (src/cli) and
 * GET /api/health (src/app/api/health) both call runDoctorReport() and
 * format its output for their own medium (terminal text vs. JSON) - neither
 * re-implements or duplicates any check. See DEPLOYMENT.md "Doctor".
 */
export const DOCTOR_CATEGORIES = [
  "environment",
  "database",
  "storage",
  "camera",
  "captureService",
  "build",
  "nodeStatus",
  "backups",
] as const;
export type DoctorCategory = (typeof DOCTOR_CATEGORIES)[number];

export const DOCTOR_CATEGORY_LABELS: Record<DoctorCategory, string> = {
  environment: "Environment",
  database: "Database",
  storage: "Storage",
  camera: "Camera",
  captureService: "Capture Service",
  build: "Build",
  nodeStatus: "Node Status",
  backups: "Backups",
};

export type DoctorCheck = CheckResult & { category: DoctorCategory };

export type DoctorReport = {
  paths: ResolvedPlantLabPaths;
  checks: DoctorCheck[];
  byCategory: Record<DoctorCategory, DoctorCheck[]>;
  summary: { ok: boolean; total: number; passCount: number; warnCount: number; failCount: number };
};

function fail(category: DoctorCategory, name: string, detail: string): DoctorCheck {
  return { category, name, status: "fail", detail };
}
function warn(category: DoctorCategory, name: string, detail: string): DoctorCheck {
  return { category, name, status: "warn", detail };
}
function pass(category: DoctorCategory, name: string, detail: string): DoctorCheck {
  return { category, name, status: "pass", detail };
}
function tag(category: DoctorCategory, result: CheckResult): DoctorCheck {
  return { ...result, category };
}

function checkRequiredEnvVars(): DoctorCheck {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) {
    missing.push("DATABASE_URL");
  }

  return missing.length > 0
    ? fail("environment", "env-vars", `Missing required environment variable(s): ${missing.join(", ")}`)
    : pass("environment", "env-vars", "DATABASE_URL is set.");
}

function checkResolvedDatabasePath(): DoctorCheck {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return fail("database", "database-path", "DATABASE_URL is not set - cannot resolve a database file.");
  }

  try {
    const dbPath = resolveSqliteDatabasePath(databaseUrl);
    return existsSync(dbPath)
      ? pass("database", "database-path", `Resolved to ${dbPath} (exists).`)
      : fail("database", "database-path", `Resolved to ${dbPath}, but no file exists there yet. Run "plantlab install" or "npm run db:push".`);
  } catch (error) {
    return fail("database", "database-path", error instanceof Error ? error.message : String(error));
  }
}

async function checkPrismaClientAvailable(): Promise<DoctorCheck> {
  try {
    const generatedClientPath = require.resolve("@prisma/client");
    return pass("database", "prisma-client", `@prisma/client resolves to ${generatedClientPath}.`);
  } catch (error) {
    return fail(
      "database",
      "prisma-client",
      `@prisma/client is not resolvable - run "npm run db:generate". (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function checkNextBuildPresent(): DoctorCheck {
  const buildIdPath = path.join(resolveRootDir(), ".next", "BUILD_ID");
  return existsSync(buildIdPath)
    ? pass("build", "next-build", `Production build found (${buildIdPath}).`)
    : fail("build", "next-build", 'No production build found. Run "npm run build" before "npm run start".');
}

async function checkCameraStableIdResolution(): Promise<DoctorCheck> {
  try {
    const { discoverLocalCameras } = await import("../v4l2");
    const cameras = await discoverLocalCameras();

    if (cameras.length === 0) {
      return warn("camera", "camera-stable-id", "No cameras were enumerated (v4l2-ctl ran, but reported none attached).");
    }

    const withoutStableId = cameras.filter((camera) => !camera.stableId);
    if (withoutStableId.length > 0) {
      return warn(
        "camera",
        "camera-stable-id",
        `${cameras.length} camera(s) found; ${withoutStableId.length} did not resolve a stable USB identity (device path may change across reboots).`,
      );
    }

    return pass("camera", "camera-stable-id", `${cameras.length} camera(s) found, all with a resolved stable identity.`);
  } catch (error) {
    return fail("camera", "camera-stable-id", error instanceof Error ? error.message : String(error));
  }
}

/** Read-only summary only - see runStorageAudit()/applyStorageRemediation() ("plantlab doctor storage") for the full report and remediation. */
async function checkOrphanProjectDirectories(): Promise<DoctorCheck> {
  try {
    const report = await auditProjectDirectories(prisma);

    if (report.nonEmptyOrphans.length > 0) {
      return warn(
        "storage",
        "orphan-project-directories",
        `${report.emptyOrphans.length} empty and ${report.nonEmptyOrphans.length} NON-EMPTY orphan project director${report.nonEmptyOrphans.length === 1 ? "y" : "ies"} found - run "plantlab doctor storage" for details (non-empty orphans are never auto-deleted).`,
      );
    }

    if (report.emptyOrphans.length > 0) {
      return warn(
        "storage",
        "orphan-project-directories",
        `${report.emptyOrphans.length} empty orphan project director${report.emptyOrphans.length === 1 ? "y" : "ies"} detected. Run "plantlab doctor storage" for details.`,
      );
    }

    return pass("storage", "orphan-project-directories", "No orphan project directories found.");
  } catch (error) {
    return warn("storage", "orphan-project-directories", error instanceof Error ? error.message : String(error));
  }
}

/** Read-only summary only - see runStorageAudit()/applyStorageRemediation() ("plantlab doctor storage") for the full report and remediation. */
async function checkStaleIngestFiles(): Promise<DoctorCheck> {
  try {
    const report = await auditStaleIngestFiles();

    if (report.staleFiles.length > 0) {
      return warn(
        "storage",
        "stale-ingest-files",
        `${report.staleFiles.length} stale .partial ingest file(s) found (${formatBytes(report.totalStaleBytes)}) - run "plantlab doctor storage" for details.`,
      );
    }

    return pass("storage", "stale-ingest-files", "No stale ingest staging files found.");
  } catch (error) {
    return warn("storage", "stale-ingest-files", error instanceof Error ? error.message : String(error));
  }
}

async function checkCaptureServiceHealth(): Promise<DoctorCheck> {
  try {
    const snapshot = await getServiceStatusSnapshot(prisma);
    if (snapshot.health === "running") {
      return pass("captureService", "capture-service", `Running (last heartbeat ${snapshot.lastHeartbeat}).`);
    }
    if (snapshot.health === "stale") {
      return warn(
        "captureService",
        "capture-service",
        `Heartbeat is stale (last: ${snapshot.lastHeartbeat ?? "never"}). The camera/scheduler service may have stopped - check "plantlab service status".`,
      );
    }
    return warn(
      "captureService",
      "capture-service",
      'No heartbeat recorded yet - the camera/scheduler service has never run against this database. Start it with "plantlab service start".',
    );
  } catch (error) {
    return warn("captureService", "capture-service", error instanceof Error ? error.message : String(error));
  }
}

async function checkNodeStatus(): Promise<DoctorCheck> {
  try {
    const config = await readNodeConfig();
    if (!config) {
      return warn("nodeStatus", "node-role", 'No role configured yet. Run "plantlab install" to configure this node.');
    }
    return pass("nodeStatus", "node-role", `Configured as "${config.role}" on ${config.hostname} (configured ${config.configuredAt}).`);
  } catch (error) {
    return warn("nodeStatus", "node-role", error instanceof Error ? error.message : String(error));
  }
}

async function coordinatorTableExists(tableName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName,
  );
  return rows.length > 0;
}

async function checkRegisteredNodes(): Promise<DoctorCheck> {
  try {
    if (!(await coordinatorTableExists("PlantLabNode"))) {
      return warn("nodeStatus", "registered-nodes", 'Coordinator node tables are not migrated yet. Run "pnpm db:push" or apply migrations before attaching nodes.');
    }
    const count = await prisma.plantLabNode.count();
    if (count === 0) {
      return warn("nodeStatus", "registered-nodes", 'No remote nodes registered yet. Run "plantlab node attach <ssh-host>" from the coordinator.');
    }
    const staleCutoff = new Date(Date.now() - 5 * 60_000);
    const stale = await prisma.plantLabNode.count({
      where: { OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleCutoff } }] },
    });
    return stale > 0
      ? warn("nodeStatus", "registered-nodes", `${count} node(s) registered; ${stale} have no recent heartbeat.`)
      : pass("nodeStatus", "registered-nodes", `${count} node(s) registered with recent heartbeats.`);
  } catch (error) {
    return warn("nodeStatus", "registered-nodes", error instanceof Error ? error.message : String(error));
  }
}

async function checkAgentJobs(): Promise<DoctorCheck> {
  try {
    if (!(await coordinatorTableExists("AgentCaptureJob"))) {
      return warn("captureService", "agent-capture-jobs", 'Agent job tables are not migrated yet. Run "pnpm db:push" or apply migrations before testing remote captures.');
    }
    const failed = await prisma.agentCaptureJob.count({ where: { status: "failed" } });
    const active = await prisma.agentCaptureJob.count({ where: { status: { in: ["queued", "claimed"] } } });
    if (failed > 0) {
      return warn("captureService", "agent-capture-jobs", `${failed} failed agent capture job(s), ${active} queued/claimed.`);
    }
    return pass("captureService", "agent-capture-jobs", `${active} queued/claimed agent capture job(s), no failures.`);
  } catch (error) {
    return warn("captureService", "agent-capture-jobs", error instanceof Error ? error.message : String(error));
  }
}

async function checkBackupsHealth(): Promise<DoctorCheck> {
  try {
    const backups = await listBackups();
    if (backups.length === 0) {
      return warn("backups", "backups", 'No backups found yet. Run "plantlab backup create".');
    }

    const mostRecentPath = backups[backups.length - 1];
    const mostRecentStat = await stat(mostRecentPath);
    const ageDays = (Date.now() - mostRecentStat.mtime.getTime()) / (24 * 60 * 60 * 1000);

    if (ageDays > 7) {
      return warn(
        "backups",
        "backups",
        `${backups.length} backup(s) found, but the most recent is ${ageDays.toFixed(1)} days old. Consider running "plantlab backup create".`,
      );
    }
    return pass("backups", "backups", `${backups.length} backup(s) found; most recent is ${ageDays.toFixed(1)} days old.`);
  } catch (error) {
    return warn("backups", "backups", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Captures one temporary frame (never registered as a Photo/SourceCapture,
 * always deleted immediately) to verify the real ffmpeg/v4l2 hardware path
 * end to end. Shared by `plantlab doctor --capture` and `plantlab camera
 * test` - see src/cli/commands/{doctor,camera}.ts - so hardware-verification
 * logic exists in exactly one place.
 */
export async function runCameraTestCapture(explicitDevice: string | null): Promise<DoctorCheck> {
  const { capturePreviewFrame } = await import("../camera");
  const { verifyCapturedDimensions } = await import("../captureVerify");
  const { discoverLocalCameras } = await import("../v4l2");

  let device = explicitDevice ?? process.env.CAMERA_DEVICE ?? null;
  if (!device) {
    const cameras = await discoverLocalCameras().catch(() => []);
    device = cameras[0]?.device ?? null;
  }

  if (!device) {
    return fail("camera", "test-capture", "No camera device specified and none could be discovered. Pass an explicit device.");
  }

  const width = Number(process.env.CAMERA_WIDTH ?? 1920);
  const height = Number(process.env.CAMERA_HEIGHT ?? 1080);
  const inputFormat = process.env.CAMERA_INPUT_FORMAT ?? "mjpeg";

  try {
    const buffer = await capturePreviewFrame({ device, width, height, inputFormat });
    const verification = await verifyCapturedDimensions(buffer, { width, height });
    const tempPath = path.join(os.tmpdir(), `plantlab-doctor-capture-${Date.now()}.jpg`);
    // Write and immediately remove - this only proves the file could be
    // written to disk, it is never registered as a Photo or kept.
    await writeFile(tempPath, buffer);
    await unlink(tempPath).catch(() => undefined);

    return verification.matched
      ? pass(
          "camera",
          "test-capture",
          `Captured ${verification.actualWidth}x${verification.actualHeight} from ${device} (matched requested resolution). Not saved.`,
        )
      : warn(
          "camera",
          "test-capture",
          `Captured from ${device}, but actual dimensions (${verification.actualWidth}x${verification.actualHeight}) did not match requested (${width}x${height}). Not saved.`,
        );
  } catch (error) {
    return fail("camera", "test-capture", error instanceof Error ? error.message : String(error));
  }
}

export type DoctorReportOptions = {
  captureRequested?: boolean;
  captureDevice?: string | null;
};

/** The single implementation behind `plantlab doctor` and `GET /api/health` - see the module doc comment. */
export async function runDoctorReport(options: DoctorReportOptions = {}): Promise<DoctorReport> {
  const paths = resolveAllPaths();
  const checks: DoctorCheck[] = [];

  checks.push(checkRequiredEnvVars());
  checks.push(checkResolvedDatabasePath());
  checks.push(await checkPrismaClientAvailable());
  checks.push(tag("database", await checkDatabaseConnectivity(prisma)));

  checks.push(tag("storage", await checkWritableDirectory("projects-data-dir", paths.projectsDataDir)));
  checks.push(tag("storage", await checkWritableDirectory("capture-sources-data-dir", paths.captureSourcesDataDir)));
  checks.push(tag("storage", await checkWritableDirectory("runtime-locks-dir", paths.runtimeLocksDir)));
  checks.push(tag("storage", await checkWritableDirectory("backup-dir", paths.backupDir)));
  checks.push(tag("storage", await checkWritableDirectory("ingest-dir", paths.ingestDir)));
  checks.push(await checkOrphanProjectDirectories());
  checks.push(await checkStaleIngestFiles());

  checks.push(tag("camera", await checkExecutable("ffmpeg", true)));
  checks.push(tag("camera", await checkExecutable("ffprobe", false)));
  checks.push(tag("camera", await checkExecutable("v4l2-ctl", false)));
  checks.push(tag("camera", await checkVideoDevices()));
  checks.push(tag("camera", await checkCameraGroupMembership()));
  checks.push(await checkCameraStableIdResolution());

  if (options.captureRequested) {
    checks.push(await runCameraTestCapture(options.captureDevice ?? null));
  } else {
    checks.push(warn("camera", "test-capture", 'Skipped (opt in with "plantlab doctor --capture" to exercise real hardware).'));
  }

  checks.push(checkNextBuildPresent());
  checks.push(await checkCaptureServiceHealth());
  checks.push(await checkAgentJobs());
  checks.push(await checkNodeStatus());
  checks.push(await checkRegisteredNodes());
  checks.push(await checkBackupsHealth());

  const byCategory = Object.fromEntries(DOCTOR_CATEGORIES.map((category) => [category, [] as DoctorCheck[]])) as Record<
    DoctorCategory,
    DoctorCheck[]
  >;
  for (const check of checks) {
    byCategory[check.category].push(check);
  }

  const passCount = checks.filter((c) => c.status === "pass").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  return {
    paths,
    checks,
    byCategory,
    summary: { ok: failCount === 0, total: checks.length, passCount, warnCount, failCount },
  };
}

export type StorageDoctorReport = {
  projectDirectories: ProjectDirectoryReport;
  ingestFiles: IngestStagingReport;
};

/** Read-only. The full detailed audit behind `plantlab doctor storage` - see applyStorageRemediation() for the (explicit opt-in only) remediation half. */
export async function runStorageAudit(options: { minAgeMs?: number } = {}): Promise<StorageDoctorReport> {
  const [projectDirectories, ingestFiles] = await Promise.all([
    auditProjectDirectories(prisma),
    auditStaleIngestFiles({ minAgeMs: options.minAgeMs }),
  ]);
  return { projectDirectories, ingestFiles };
}

export type StorageRemediationOptions = {
  removeEmptyOrphans?: boolean;
  removeStaleIngestFiles?: boolean;
  ignoreAge?: boolean;
  minAgeMs?: number;
};

export type StorageRemediationResult = {
  emptyOrphans?: RemoveEmptyOrphansResult;
  staleIngestFiles?: RemoveStaleIngestFilesResult;
};

/** Ordinary application startup must never call this - it is only ever invoked from an explicit CLI flag. */
export async function applyStorageRemediation(
  report: StorageDoctorReport,
  options: StorageRemediationOptions,
): Promise<StorageRemediationResult> {
  const result: StorageRemediationResult = {};

  if (options.removeEmptyOrphans) {
    result.emptyOrphans = await removeEmptyOrphans(report.projectDirectories, {
      minAgeMs: options.minAgeMs,
      ignoreAge: options.ignoreAge,
    });
  }
  if (options.removeStaleIngestFiles) {
    result.staleIngestFiles = await removeStaleIngestFiles(report.ingestFiles, { ignoreAge: options.ignoreAge });
  }

  return result;
}

export { DEFAULT_MIN_ORPHAN_AGE_MS, DEFAULT_STALE_INGEST_AGE_MS, formatBytes };
