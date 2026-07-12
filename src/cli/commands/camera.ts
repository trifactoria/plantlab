import type { Command } from "commander";
import { runCameraTestCapture } from "../../lib/operations/doctor";
import { discoverLocalCameras } from "../../lib/v4l2";
import { formatCheckLine } from "../format";

async function listCameras(): Promise<void> {
  const cameras = await discoverLocalCameras();

  if (cameras.length === 0) {
    console.log("No local cameras discovered (v4l2-ctl ran, but reported none attached).");
    return;
  }

  for (const camera of cameras) {
    console.log(`${camera.device}`);
    console.log(`  name:      ${camera.name ?? "(unknown)"}`);
    console.log(`  stable id: ${camera.stableId ?? "(none - device path may change across reboots)"}`);
  }
}

export function registerCameraCommand(program: Command): void {
  const camera = program.command("camera").description("Inspect and test locally attached cameras");

  camera
    .command("list")
    .description("List cameras discovered on this machine via v4l2-ctl")
    .action(async () => {
      await listCameras();
    });

  camera
    .command("attach")
    .description("Show discovered cameras and how to register one as a project camera or shared capture source")
    .action(async () => {
      await listCameras();
      console.log("");
      console.log(
        "Registering a camera as a project camera or a shared CaptureSource is currently done through the web UI\n" +
          "(a project's Settings page, or /capture-sources) or the corresponding HTTP API. A dedicated CLI flow for\n" +
          "this is intentionally deferred to future capture-agent work - see ARCHITECTURE.md.",
      );
    });

  camera
    .command("test")
    .description("Capture one temporary frame from a camera to verify the hardware path (never saved)")
    .argument("[device]", "Device path, e.g. /dev/video0 (defaults to CAMERA_DEVICE or the first discovered camera)")
    .action(async (device: string | undefined) => {
      const result = await runCameraTestCapture(device ?? null);
      console.log(formatCheckLine(result));
      if (result.status === "fail") {
        process.exitCode = 1;
      }
    });
}
