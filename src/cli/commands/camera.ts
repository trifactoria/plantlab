import type { Command } from "commander";
import { runCameraTestCapture } from "../../lib/operations/doctor";
import { attachNodeCamera, firstSupportedMode, listNodeCameras } from "../../lib/operations/nodeCameras";
import { prisma } from "../../lib/prisma";
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
  const camera = program
    .command("camera")
    .description("Inspect and test locally attached cameras")
    .addHelpText(
      "after",
      `

Examples:
  plantlab camera list
  plantlab camera list --node xps
  plantlab camera attach --node xps
  plantlab camera test /dev/video4
`,
    );

  camera
    .command("list")
    .description("List cameras discovered on this machine via v4l2-ctl")
    .option("--node <name>", "List camera inventory last reported by a registered node")
    .option("--json", "Print structured JSON")
    .action(async (options: { node?: string; json?: boolean }) => {
      if (options.node) {
        const nodes = await listNodeCameras(prisma, options.node);
        if (options.json) {
          console.log(JSON.stringify(nodes, null, 2));
          return;
        }
        if (nodes.length === 0) {
          console.log(`No registered node named "${options.node}".`);
          return;
        }
        for (const node of nodes) {
          console.log(`Node: ${node.name}`);
          if (node.cameras.length === 0) {
            console.log("  No cameras reported yet. Start the remote agent or run plantlab node attach again.");
            continue;
          }
          node.cameras.forEach((camera, index) => {
            console.log(`\n${index + 1}. ${camera.name ?? "Unknown camera"}`);
            console.log(`   Device: ${camera.devicePath}`);
            console.log(`   Stable ID: ${camera.stableId}`);
            console.log(`   Status: ${camera.available ? "available" : "not seen recently"}`);
            if (camera.formats.length > 0) {
              console.log("   Formats:");
              for (const format of camera.formats) {
                for (const resolution of format.resolutions) {
                  console.log(`     ${format.pixelFormat.toUpperCase()} ${resolution.width}x${resolution.height}`);
                }
              }
            }
          });
        }
        return;
      }
      await listCameras();
    });

  camera
    .command("attach")
    .description("Attach a node camera to a coordinator CaptureSource")
    .requiredOption("--node <name>", "Registered node name, e.g. xps")
    .option("--camera <stable-id-or-index>", "Camera stable ID or 1-based index from camera list")
    .option("--capture-source <id>", "Existing CaptureSource id to use")
    .option("--name <name>", "Name for a new CaptureSource")
    .option("--width <px>", "Capture width", (value) => Number(value))
    .option("--height <px>", "Capture height", (value) => Number(value))
    .option("--format <format>", "Input pixel format, e.g. mjpeg")
    .option("--yes", "Proceed without interactive confirmation")
    .option("--json", "Print structured JSON")
    .action(
      async (options: {
        node: string;
        camera?: string;
        captureSource?: string;
        name?: string;
        width?: number;
        height?: number;
        format?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        const nodes = await listNodeCameras(prisma, options.node);
        const node = nodes[0];
        if (!node) {
          console.error(`No registered node named "${options.node}". Run "plantlab node attach ${options.node}" first.`);
          process.exitCode = 1;
          return;
        }
        if (node.cameras.length === 0) {
          console.error(`Node "${options.node}" has not reported any cameras yet. Ensure plantlab-agent.service is running.`);
          process.exitCode = 1;
          return;
        }
        const camera =
          options.camera && /^\d+$/.test(options.camera)
            ? node.cameras[Number(options.camera) - 1]
            : options.camera
              ? node.cameras.find((item) => item.stableId === options.camera)
              : node.cameras[0];
        if (!camera) {
          console.error(`Camera "${options.camera}" was not found on node "${options.node}".`);
          process.exitCode = 1;
          return;
        }
        const mode = firstSupportedMode(camera);
        const width = options.width ?? mode.width;
        const height = options.height ?? mode.height;
        const inputFormat = options.format ?? mode.inputFormat;
        const newName = options.name ?? `${node.name} ${camera.name ?? "Camera"}`;

        if (!options.yes && process.stdin.isTTY) {
          console.log(`Attach camera "${camera.name ?? camera.stableId}" on node "${node.name}"`);
          console.log(`CaptureSource: ${options.captureSource ? `existing ${options.captureSource}` : `new "${newName}"`}`);
          console.log(`Mode: ${inputFormat.toUpperCase()} ${width}x${height}`);
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
            if (answer !== "y" && answer !== "yes") {
              console.log("No changes made.");
              return;
            }
          } finally {
            rl.close();
          }
        } else if (!options.yes && !process.stdin.isTTY) {
          console.error("Refusing to attach a camera without confirmation. Re-run with --yes.");
          process.exitCode = 1;
          return;
        }

        const result = await attachNodeCamera(prisma, {
          nodeName: node.name,
          stableId: camera.stableId,
          captureSourceId: options.captureSource ?? null,
          newCaptureSourceName: newName,
          width,
          height,
          inputFormat,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log("Camera attached.");
          console.log(`Node: ${result.node.name}`);
          console.log(`Camera: ${result.camera.name ?? result.camera.stableId}`);
          console.log(`CaptureSource: ${result.captureSource.name}`);
          console.log(`Mode: ${result.assignment.inputFormat.toUpperCase()} ${result.assignment.width}x${result.assignment.height}`);
        }
      },
    );

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
