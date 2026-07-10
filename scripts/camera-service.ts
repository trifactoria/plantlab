import { captureProjectPhoto } from "../src/lib/camera";
import { CaptureScheduler, consoleLogger } from "../src/lib/captureService";
import { prisma } from "../src/lib/prisma";
import { writeHeartbeat } from "../src/lib/serviceStatus";

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

async function main() {
  consoleLogger.info("PlantLab capture service starting", {
    pid: process.pid,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  });

  const scheduler = new CaptureScheduler({
    prisma,
    captureProjectPhoto,
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

    await writeHeartbeat(prisma, { startedAt, lastError });

    if (stopping) {
      break;
    }

    await sleep(scheduler.msUntilNextWake(REFRESH_INTERVAL_MS));
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
