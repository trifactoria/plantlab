// Development/debugging command for watching a single project's schedule.
// The long-term, multi-project operating mode is `pnpm camera:service`
// (see scripts/camera-service.ts), which does not require a project id.
import { captureProjectPhoto } from "../src/lib/camera";
import { formatDateTime } from "../src/lib/format";
import { prisma } from "../src/lib/prisma";
import { nextAlignedCaptureTime } from "../src/lib/schedule";

let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(`\n${signal} received. Stopping after current wait or capture.`);
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
    }, 500);
  });
}

async function main() {
  const projectId = process.argv.slice(2).find((argument) => argument !== "--");

  if (!projectId) {
    throw new Error("Usage: pnpm camera:watch -- <project-id>");
  }

  while (!stopping) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const device = process.env.CAMERA_DEVICE || project.cameraDevice;
    if (!device) {
      console.log("No camera selected for this project. Rechecking in 30 seconds.");
      await sleep(30_000);
      continue;
    }

    const nextCaptureAt = nextAlignedCaptureTime({
      startAt: project.captureStartAt,
      intervalMinutes: project.photoIntervalMinutes,
    });
    const waitMs = Math.max(0, nextCaptureAt.getTime() - Date.now());

    console.log("");
    console.log(`Project: ${project.name}`);
    console.log(`Camera: ${project.cameraName ?? "Camera"} (${device})`);
    console.log(`Output directory: ${project.localPhotoDirectory}`);
    console.log(`Interval: ${project.photoIntervalMinutes} minutes`);
    console.log(`Schedule start: ${formatDateTime(project.captureStartAt)}`);
    console.log(`Next capture: ${formatDateTime(nextCaptureAt)}`);

    await sleep(waitMs);

    if (stopping) {
      break;
    }

    try {
      const result = await captureProjectPhoto(projectId);
      console.log(`Captured photo: ${result.savedPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Capture failed";
      console.error(`Capture failed: ${message}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
