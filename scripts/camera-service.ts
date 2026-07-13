import "../src/lib/suppressExpectedWarnings";
import { captureProjectPhoto } from "../src/lib/camera";
import { CaptureScheduler, consoleLogger } from "../src/lib/captureService";
import { CaptureSourceScheduler } from "../src/lib/captureSourceService";
import { logResolvedPaths, resolveDataDir, resolveRuntimeLocksDir } from "../src/lib/paths.server";
import { prisma } from "../src/lib/prisma";
import { writeHeartbeat } from "../src/lib/serviceStatus";
import { captureSourcePhoto } from "../src/lib/sourceCapture";
import { checkExecutable, checkWritableDirectory, formatCheckLine } from "../src/lib/startupChecks";
import { runViewportFanOut } from "../src/lib/viewportFanOut";

const REFRESH_INTERVAL_MS = Number(process.env.CAPTURE_SERVICE_REFRESH_INTERVAL_MS ?? 15_000);
const startedAt = new Date();

let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) {
      return;
    }

    stopping = true;
    consoleLogger.info(`${signal} received, stopping after the current cycle`);
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    const interval = setInterval(() => {
      if (stopping) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 250);
  });
}

async function runStartupChecks() {
  logResolvedPaths();

  const results = [
    await checkExecutable("ffmpeg", true),
    await checkExecutable("v4l2-ctl", false),
    await checkWritableDirectory("data-dir", resolveDataDir()),
    await checkWritableDirectory("runtime-locks-dir", resolveRuntimeLocksDir()),
  ];

  for (const result of results) {
    const line = formatCheckLine(result);
    if (result.status === "fail") {
      consoleLogger.error(line);
    } else if (result.status === "warn") {
      consoleLogger.warn(line);
    } else {
      consoleLogger.info(line);
    }
  }

  const hardFailure = results.find((result) => result.status === "fail");
  if (hardFailure) {
    throw new Error(
      `Startup check failed: ${hardFailure.name} - ${hardFailure.detail}. Run "npm run doctor" for a full report.`,
    );
  }
}

async function main() {
  consoleLogger.info("PlantLab capture service starting", {
    pid: process.pid,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  });

  await runStartupChecks();

  const scheduler = new CaptureScheduler({
    prisma,
    captureProjectPhoto,
    logger: consoleLogger,
  });

  // Independent from the per-project scheduler above: schedules shared
  // CaptureSources (grow-tent shelf cameras), capturing each due source
  // once and fanning it out to every project with an applicable viewport -
  // see src/lib/captureSourceService.ts.
  const sourceScheduler = new CaptureSourceScheduler({
    prisma,
    captureSourcePhoto,
    runViewportFanOut,
    logger: consoleLogger,
  });

  await writeHeartbeat(prisma, { startedAt });

  while (!stopping) {
    let lastError: string | null = null;

    try {
      const result = await scheduler.tick();

      if (result.dueCount > 0) {
        const failures = result.captures.filter((capture) => capture.status === "failed");
        consoleLogger.info("Capture cycle complete", {
          dueCount: result.dueCount,
          succeeded: result.captures.length - failures.length,
          failed: failures.length,
        });
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown scheduler error";
      consoleLogger.error("Scheduler tick failed", { error: lastError });
    }

    try {
      const sourceResult = await sourceScheduler.tick();

      if (sourceResult.dueCount > 0) {
        const failures = sourceResult.captures.filter((capture) => capture.status === "failed");
        consoleLogger.info("Capture source cycle complete", {
          dueCount: sourceResult.dueCount,
          succeeded: sourceResult.captures.length - failures.length,
          failed: failures.length,
        });
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown capture source scheduler error";
      consoleLogger.error("Capture source scheduler tick failed", { error: lastError });
    }

    await writeHeartbeat(prisma, { startedAt, lastError });

    if (stopping) {
      break;
    }

    await sleep(Math.min(scheduler.msUntilNextWake(REFRESH_INTERVAL_MS), sourceScheduler.msUntilNextWake(REFRESH_INTERVAL_MS)));
  }

  consoleLogger.info("PlantLab capture service stopped");
}

main()
  .catch((error) => {
    consoleLogger.error("Fatal capture service error", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
