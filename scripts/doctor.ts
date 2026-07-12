/**
 * Production readiness check for PlantLab. Reports actionable pass/fail
 * results for everything a clean deployment needs (env vars, database,
 * data directories, native camera tooling, device visibility, group
 * membership, and the Next.js build), without mutating any canonical
 * project data unless the caller explicitly opts into a real hardware
 * test capture.
 *
 * Usage:
 *   npm run doctor                    - read-only checks only
 *   npm run doctor -- --capture       - also captures one temporary frame
 *                                        (not saved as a project photo) to
 *                                        verify the full ffmpeg/v4l2 path
 *   npm run doctor -- --capture=/dev/video0   - use a specific device
 */
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { resolveAllPaths, resolveRootDir, resolveSqliteDatabasePath } from "../src/lib/paths";
import { prisma } from "../src/lib/prisma";
import {
  checkCameraGroupMembership,
  checkDatabaseConnectivity,
  checkExecutable,
  checkVideoDevices,
  checkWritableDirectory,
  formatCheckLine,
  summarizeChecks,
  type CheckResult,
} from "../src/lib/startupChecks";

function fail(name: string, detail: string): CheckResult {
  return { name, status: "fail", detail };
}
function warn(name: string, detail: string): CheckResult {
  return { name, status: "warn", detail };
}
function pass(name: string, detail: string): CheckResult {
  return { name, status: "pass", detail };
}

function checkRequiredEnvVars(): CheckResult {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) {
    missing.push("DATABASE_URL");
  }

  if (missing.length > 0) {
    return fail("env-vars", `Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return pass("env-vars", "DATABASE_URL is set.");
}

function checkResolvedDatabasePath(): { result: CheckResult; dbPath: string | null } {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { result: fail("database-path", "DATABASE_URL is not set - cannot resolve a database file."), dbPath: null };
  }

  try {
    const dbPath = resolveSqliteDatabasePath(databaseUrl);
    const exists = existsSync(dbPath);
    return {
      result: exists
        ? pass("database-path", `Resolved to ${dbPath} (exists).`)
        : fail("database-path", `Resolved to ${dbPath}, but no file exists there yet. Run "npm run db:push".`),
      dbPath,
    };
  } catch (error) {
    return { result: fail("database-path", error instanceof Error ? error.message : String(error)), dbPath: null };
  }
}

async function checkPrismaClientAvailable(): Promise<CheckResult> {
  try {
    const generatedClientPath = require.resolve("@prisma/client");
    return pass("prisma-client", `@prisma/client resolves to ${generatedClientPath}.`);
  } catch (error) {
    return fail(
      "prisma-client",
      `@prisma/client is not resolvable - run "npm run db:generate". (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function checkNextBuildPresent(): CheckResult {
  const buildIdPath = path.join(resolveRootDir(), ".next", "BUILD_ID");
  if (existsSync(buildIdPath)) {
    return pass("next-build", `Production build found (${buildIdPath}).`);
  }

  return fail("next-build", 'No production build found. Run "npm run build" before "npm run start".');
}

async function checkCameraStableIdResolution(): Promise<CheckResult> {
  try {
    const { discoverLocalCameras } = await import("../src/lib/v4l2");
    const cameras = await discoverLocalCameras();

    if (cameras.length === 0) {
      return warn("camera-stable-id", "No cameras were enumerated (v4l2-ctl ran, but reported none attached).");
    }

    const withoutStableId = cameras.filter((camera) => !camera.stableId);
    if (withoutStableId.length > 0) {
      return warn(
        "camera-stable-id",
        `${cameras.length} camera(s) found; ${withoutStableId.length} did not resolve a stable USB identity (device path may change across reboots).`,
      );
    }

    return pass("camera-stable-id", `${cameras.length} camera(s) found, all with a resolved stable identity.`);
  } catch (error) {
    return fail("camera-stable-id", error instanceof Error ? error.message : String(error));
  }
}

function parseCaptureFlag(argv: string[]): { requested: boolean; device: string | null } {
  const flag = argv.find((arg) => arg === "--capture" || arg.startsWith("--capture="));
  if (!flag) {
    return { requested: false, device: null };
  }

  const eq = flag.indexOf("=");
  return { requested: true, device: eq === -1 ? null : flag.slice(eq + 1) };
}

async function runOptionalTestCapture(explicitDevice: string | null): Promise<CheckResult> {
  const { capturePreviewFrame } = await import("../src/lib/camera");
  const { verifyCapturedDimensions } = await import("../src/lib/captureVerify");
  const { discoverLocalCameras } = await import("../src/lib/v4l2");

  let device = explicitDevice ?? process.env.CAMERA_DEVICE ?? null;
  if (!device) {
    const cameras = await discoverLocalCameras().catch(() => []);
    device = cameras[0]?.device ?? null;
  }

  if (!device) {
    return fail("test-capture", "No camera device specified and none could be discovered. Pass --capture=/dev/videoN.");
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tempPath, buffer);
    await unlink(tempPath).catch(() => undefined);

    return verification.matched
      ? pass(
          "test-capture",
          `Captured ${verification.actualWidth}x${verification.actualHeight} from ${device} (matched requested resolution). Not saved.`,
        )
      : warn(
          "test-capture",
          `Captured from ${device}, but actual dimensions (${verification.actualWidth}x${verification.actualHeight}) did not match requested (${width}x${height}). Not saved.`,
        );
  } catch (error) {
    return fail("test-capture", error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { requested: captureRequested, device: captureDevice } = parseCaptureFlag(argv);

  console.log("PlantLab production readiness check\n");

  const paths = resolveAllPaths();
  console.log("Resolved paths:");
  for (const [key, value] of Object.entries(paths)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log("");

  const results: CheckResult[] = [];

  results.push(checkRequiredEnvVars());

  const { result: dbPathResult } = checkResolvedDatabasePath();
  results.push(dbPathResult);

  results.push(await checkPrismaClientAvailable());
  results.push(await checkDatabaseConnectivity(prisma));

  results.push(await checkWritableDirectory("projects-data-dir", paths.projectsDataDir));
  results.push(await checkWritableDirectory("capture-sources-data-dir", paths.captureSourcesDataDir));
  results.push(await checkWritableDirectory("runtime-locks-dir", paths.runtimeLocksDir));
  results.push(await checkWritableDirectory("backup-dir", paths.backupDir));

  results.push(await checkExecutable("ffmpeg", true));
  results.push(await checkExecutable("ffprobe", false));
  results.push(await checkExecutable("v4l2-ctl", false));

  results.push(await checkVideoDevices());
  results.push(await checkCameraGroupMembership());
  results.push(await checkCameraStableIdResolution());

  results.push(checkNextBuildPresent());

  if (captureRequested) {
    console.log("--capture requested: performing one real hardware test capture (not saved as a project photo).\n");
    results.push(await runOptionalTestCapture(captureDevice));
  } else {
    results.push({
      name: "test-capture",
      status: "warn",
      detail: 'Skipped (opt in with "npm run doctor -- --capture" to exercise real hardware).',
    });
  }

  for (const result of results) {
    console.log(formatCheckLine(result));
  }

  const summary = summarizeChecks(results);
  console.log("");
  console.log(`${results.length} checks: ${results.length - summary.failCount - summary.warnCount} passed, ${summary.warnCount} warned, ${summary.failCount} failed.`);

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("Doctor check crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
