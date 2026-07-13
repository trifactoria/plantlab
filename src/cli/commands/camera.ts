import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import {
  type CaptureSourceInspection,
  deleteEmptyCaptureSource,
  describeReasons,
  findSuspiciousCaptureSources,
  inspectCaptureSourceByIdOrName,
  renameCaptureSource,
} from "../../lib/operations/captureSourceDoctor";
import { runCameraTestCapture } from "../../lib/operations/doctor";
import { inventoryDiagnosticsForCamera, requestCameraInventoryRefresh } from "../../lib/operations/agentProtocol";
import { attachNodeCamera, firstSupportedMode, listNodeCameras, nodeCameraDisplayName } from "../../lib/operations/nodeCameras";
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
    if (camera.usbPort || camera.physicalPath) {
      console.log(`  usb path:  ${camera.usbPort ?? camera.physicalPath}`);
    }
    console.log(`  stable id: ${camera.stableId ?? "(none - device path may change across reboots)"}`);
    if (camera.alternateDevices && camera.alternateDevices.length > 0) {
      for (const alternate of camera.alternateDevices) {
        console.log(`  alternate: ${alternate.device}${alternate.reason ? ` (${alternate.reason})` : ""}`);
      }
    }
  }
}

type CameraAttachOptions = {
  node: string;
  camera?: string;
  captureSource?: string;
  name?: string;
  width?: number;
  height?: number;
  format?: string;
  yes?: boolean;
  json?: boolean;
  prompt?: (question: string) => Promise<string>;
  interactive?: boolean;
};

type NodeCameraListOptions = { node?: string; verbose?: boolean; json?: boolean };

function formatPixelFormat(pixelFormat: string) {
  if (pixelFormat === "mjpeg") return "MJPEG";
  if (pixelFormat === "yuyv422") return "YUYV";
  return pixelFormat.toUpperCase();
}

function modeLines(camera: { formats: Array<{ pixelFormat: string; resolutions: Array<{ width: number; height: number; frameRates: string[] }> }> }) {
  return camera.formats.flatMap((format) =>
    format.resolutions.map((resolution) => {
      const fps = resolution.frameRates.length > 0 ? ` @ ${resolution.frameRates.join(", ")}` : "";
      return `${formatPixelFormat(format.pixelFormat)} ${resolution.width}x${resolution.height}${fps}`;
    }),
  );
}

function nodeInventoryJson(nodes: Awaited<ReturnType<typeof listNodeCameras>>) {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    hostname: node.hostname,
    status: node.status,
    runtime: node.runtime,
    protocolVersion: node.protocolVersion,
    softwareVersion: node.softwareVersion,
    lastHeartbeatAt: node.lastHeartbeatAt,
    lastInventoryAt: node.lastInventoryAt,
    inventoryRefreshRequestedAt: node.inventoryRefreshRequestedAt,
    cameras: node.cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      displayName: nodeCameraDisplayName(camera),
      stableId: camera.stableId,
      legacyStableId: camera.legacyStableId,
      devicePath: camera.devicePath,
      physicalPath: camera.physicalPath,
      usbPath: camera.usbPath,
      usbPort: camera.usbPort,
      vendorId: camera.vendorId,
      productId: camera.productId,
      serial: camera.serial,
      alternateDevices: camera.alternateDevices,
      available: camera.available,
      captureSourceId: camera.captureSourceId,
      lastSeenAt: camera.lastSeenAt,
      diagnostics: inventoryDiagnosticsForCamera(camera),
      formats: camera.formats,
      modes: modeLines(camera),
    })),
  }));
}

function printNodeCameraInventory(nodes: Awaited<ReturnType<typeof listNodeCameras>>, options: { verbose?: boolean } = {}) {
  if (nodes.length === 0) {
    console.log("No matching registered node found.");
    return;
  }
  for (const node of nodes) {
    console.log(`Node: ${node.name}`);
    console.log(`  Runtime: ${node.runtime ?? "(unknown)"}${node.softwareVersion ? ` ${node.softwareVersion}` : ""}`);
    console.log(`  Protocol: ${node.protocolVersion ?? "(unknown)"}`);
    console.log(`  Last heartbeat: ${node.lastHeartbeatAt?.toISOString() ?? "(never)"}`);
    console.log(`  Last inventory: ${node.lastInventoryAt?.toISOString() ?? "(never)"}`);
    if (node.inventoryRefreshRequestedAt) {
      console.log(`  Refresh requested: ${node.inventoryRefreshRequestedAt.toISOString()}`);
    }
    if (node.cameras.length === 0) {
      console.log("  No cameras reported yet.");
      continue;
    }
    const legacyGroups = new Map<string, typeof node.cameras>();
    for (const camera of node.cameras) {
      if (!camera.legacyStableId || camera.legacyStableId === camera.stableId) continue;
      legacyGroups.set(camera.legacyStableId, [...(legacyGroups.get(camera.legacyStableId) ?? []), camera]);
    }
    for (const [legacyStableId, group] of legacyGroups) {
      if (group.length < 2) continue;
      const attached = group.find((camera) => camera.captureSourceId);
      console.log("");
      console.log(`  Duplicate USB serial split detected from old identity ${legacyStableId}.`);
      if (attached) {
        console.log(`  Existing assignment preserved on ${nodeCameraDisplayName(attached)} (${attached.devicePath}).`);
      }
      for (const camera of group.filter((item) => !item.captureSourceId)) {
        console.log(`  New camera discovered, not attached automatically: ${nodeCameraDisplayName(camera)} (${camera.devicePath}).`);
      }
    }
    node.cameras.forEach((camera, index) => {
      const diagnostics = inventoryDiagnosticsForCamera(camera);
      console.log(`\n${index + 1}. ${nodeCameraDisplayName(camera)}`);
      console.log(`   Primary: ${camera.devicePath}`);
      if (camera.alternateDevices.length > 0) {
        console.log(`   Alternate: ${camera.alternateDevices.map((alternate) => alternate.device).join(", ")}`);
      }
      if (camera.physicalPath || camera.usbPath || camera.usbPort) {
        console.log(`   USB path: ${camera.usbPort ?? camera.physicalPath ?? camera.usbPath}`);
      }
      console.log(`   Stable ID: ${camera.stableId}`);
      if (camera.legacyStableId && camera.legacyStableId !== camera.stableId) {
        console.log(`   Legacy stable ID: ${camera.legacyStableId}`);
      }
      console.log(`   Status: ${camera.available ? "available" : "not seen recently"}`);
      console.log(`   Last inventory received: ${diagnostics.lastInventoryReceivedAt?.toISOString() ?? "(never)"}`);
      console.log(`   Formats: ${diagnostics.formatsReceivedCount}; modes: ${diagnostics.modesReceivedCount}; formatsJson empty: ${diagnostics.formatsJsonEmpty ? "yes" : "no"}`);
      if (camera.formats.length > 0) {
        console.log("   Modes:");
        for (const line of modeLines(camera)) {
          console.log(`     ${line}`);
        }
      } else {
        console.log("   Modes: (none stored)");
      }
      if (options.verbose) {
        console.log(`   Raw formatsJson bytes: ${camera.formatsJson?.length ?? 0}`);
        console.log(`   Capture source: ${camera.captureSourceId ?? "(none)"}`);
      }
    });
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function chooseIndex(prompt: string, count: number, fallback = 1, askFn = ask): Promise<number> {
  for (;;) {
    const answer = await askFn(`${prompt} [1-${count}, default ${fallback}]: `);
    if (!answer) return fallback - 1;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= count) {
      return index - 1;
    }
    console.log(`Enter a number between 1 and ${count}.`);
  }
}

function printCaptureSourceInspection(inspection: CaptureSourceInspection): void {
  console.log(`"${inspection.source.name}" (id: ${inspection.source.id})`);
  console.log(`  Device: ${inspection.source.cameraDevice}`);
  console.log(`  Captures: ${inspection.captureCount}`);
  console.log(`  Project viewports: ${inspection.viewportCount}`);
  console.log(`  Created: ${inspection.source.createdAt.toISOString()}`);
  if (inspection.suspicious) {
    console.log("  Looks accidental or unused:");
    for (const reason of describeReasons(inspection.reasons)) {
      console.log(`    - ${reason}`);
    }
  } else {
    console.log("  Does not look accidental or unused.");
  }
}

/**
 * Never runs automatically - always presents Rename / Delete-if-empty /
 * Leave-unchanged and requires an explicit interactive choice (Part 8).
 */
async function guideCaptureSourceAction(inspection: CaptureSourceInspection, askFn: (question: string) => Promise<string>): Promise<void> {
  console.log("\nWhat would you like to do?");
  console.log("1) Rename");
  console.log("2) Delete (only if empty)");
  console.log("3) Leave unchanged");
  const choice = await chooseIndex("Choice", 3, 3, askFn);
  if (choice === 0) {
    const name = await askFn(`New name [${inspection.source.name}]: `);
    if (!name.trim()) {
      console.log("No name entered; leaving unchanged.");
      return;
    }
    await renameCaptureSource(prisma, inspection.source.id, name);
    console.log(`Renamed to "${name.trim()}".`);
  } else if (choice === 1) {
    if (inspection.captureCount > 0 || inspection.viewportCount > 0) {
      console.log(`Not empty (${inspection.captureCount} capture(s), ${inspection.viewportCount} viewport(s)); refusing to delete.`);
      return;
    }
    const confirm = await askFn(`Delete "${inspection.source.name}"? This cannot be undone. [y/N] `);
    if (/^y/i.test(confirm.trim())) {
      await deleteEmptyCaptureSource(prisma, inspection.source.id);
      console.log("Deleted.");
    } else {
      console.log("Left unchanged.");
    }
  } else {
    console.log("Left unchanged.");
  }
}

export async function runCameraAttachFlow(options: CameraAttachOptions) {
  const nodes = await listNodeCameras(prisma, options.node);
  const node = nodes[0];
  if (!node) {
    throw new Error(`No registered node named "${options.node}". Run "plantlab node attach ${options.node}" first.`);
  }
  if (node.cameras.length === 0) {
    throw new Error(`Node "${options.node}" has not reported any cameras yet. Ensure plantlab-agent.service is running.`);
  }

  const askFn = options.prompt ?? ask;
  const canPrompt = (options.interactive ?? Boolean(process.stdin.isTTY)) && !options.yes;

  let selectedCamera =
    options.camera && /^\d+$/.test(options.camera)
      ? node.cameras[Number(options.camera) - 1]
      : options.camera
        ? node.cameras.find((item) => item.stableId === options.camera)
        : undefined;

  if (!selectedCamera && canPrompt) {
    console.log("Select a camera:");
    node.cameras.forEach((camera, index) => {
      console.log(`\n${index + 1}) ${nodeCameraDisplayName(camera)}`);
      console.log(`   Primary: ${camera.devicePath}`);
      if (camera.alternateDevices?.length) {
        console.log(`   Alternate: ${camera.alternateDevices.map((alternate) => alternate.device).join(", ")}`);
      }
      console.log(`   Stable ID: ${camera.stableId}`);
    });
    selectedCamera = node.cameras[await chooseIndex("Camera", node.cameras.length, 1, askFn)];
  }
  selectedCamera ??= node.cameras[0];
  if (!selectedCamera) {
    throw new Error(`Camera "${options.camera}" was not found on node "${options.node}".`);
  }

  const sources = await prisma.captureSource.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  let captureSourceId = options.captureSource ?? null;
  let newName = options.name ?? `${node.name} ${selectedCamera.name ?? "Camera"}`;

  if (!captureSourceId && canPrompt) {
    console.log("\nAttach to:");
    console.log("1) Existing capture source");
    console.log("2) Create new capture source");
    const choice = await chooseIndex("Choice", 2, sources.length > 0 ? 1 : 2, askFn);
    if (choice === 0 && sources.length > 0) {
      console.log("\nExisting capture sources:");
      sources.forEach((source, index) => console.log(`${index + 1}) ${source.name}`));
      const chosenSource = sources[await chooseIndex("Capture source", sources.length, 1, askFn)];
      const inspection = await inspectCaptureSourceByIdOrName(prisma, chosenSource.id);

      if (inspection.suspicious) {
        // Part 8: never silently reuse a source that looks like it came
        // from a failed/accidental onboarding (e.g. one literally named
        // "2") - make the user choose explicitly.
        console.log(`\n"${inspection.source.name}" looks like it may be an accidental or unused capture source:`);
        for (const reason of describeReasons(inspection.reasons)) {
          console.log(`  - ${reason}`);
        }
        console.log("\nThis camera should not silently reuse it. Choose:");
        console.log("1) Create a properly named capture source instead");
        console.log("2) Choose a different existing capture source");
        console.log(`3) Rename "${inspection.source.name}" and use it`);
        const resolution = await chooseIndex("Choice", 3, 1, askFn);
        if (resolution === 1) {
          const remaining = sources.filter((source) => source.id !== chosenSource.id);
          if (remaining.length === 0) {
            console.log("No other existing capture sources are available; creating a new one instead.");
            const answer = await askFn(`Capture source name [${newName}]: `);
            if (answer) newName = answer;
          } else {
            console.log("\nExisting capture sources:");
            remaining.forEach((source, index) => console.log(`${index + 1}) ${source.name}`));
            captureSourceId = remaining[await chooseIndex("Capture source", remaining.length, 1, askFn)].id;
          }
        } else if (resolution === 2) {
          const answer = await askFn(`Rename "${inspection.source.name}" to: `);
          if (answer.trim()) {
            await renameCaptureSource(prisma, chosenSource.id, answer);
          }
          captureSourceId = chosenSource.id;
        } else {
          const answer = await askFn(`Capture source name [${newName}]: `);
          if (answer) newName = answer;
        }
      } else {
        captureSourceId = chosenSource.id;
      }
    } else {
      if (choice === 0 && sources.length === 0) {
        console.log("No existing capture sources are available; creating a new one.");
      }
      const answer = await askFn(`Capture source name [${newName}]: `);
      if (answer) newName = answer;
    }
  }

  const mode = firstSupportedMode(selectedCamera);
  const resolutionChoices = selectedCamera.formats.flatMap((format) =>
    format.resolutions.map((resolution) => ({
      width: resolution.width,
      height: resolution.height,
      inputFormat: format.pixelFormat || "mjpeg",
    })),
  );
  let width = options.width ?? mode.width;
  let height = options.height ?? mode.height;
  let inputFormat = options.format ?? mode.inputFormat;
  if (!options.width && !options.height && canPrompt && resolutionChoices.length > 0) {
    console.log("\nResolution:");
    resolutionChoices.forEach((choice, index) => console.log(`${index + 1}) ${choice.width}x${choice.height} ${choice.inputFormat.toUpperCase()}`));
    const selected = resolutionChoices[await chooseIndex("Resolution", resolutionChoices.length, 1, askFn)];
    width = selected.width;
    height = selected.height;
    inputFormat = selected.inputFormat;
  }

  if (!options.yes && !canPrompt) {
    throw new Error("Refusing to attach a camera without confirmation. Re-run with --yes.");
  }

  const result = await attachNodeCamera(prisma, {
    nodeName: node.name,
    stableId: selectedCamera.stableId,
    captureSourceId,
    newCaptureSourceName: newName,
    width,
    height,
    inputFormat,
  });
  return result;
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
    .option("--verbose", "Show inventory diagnostics and stored modes")
    .option("--json", "Print structured JSON")
    .action(async (options: NodeCameraListOptions) => {
      if (options.node) {
        const nodes = await listNodeCameras(prisma, options.node);
        if (options.json) {
          console.log(JSON.stringify(nodeInventoryJson(nodes), null, 2));
          return;
        }
        if (nodes.length === 0) console.log(`No registered node named "${options.node}".`);
        else printNodeCameraInventory(nodes, { verbose: options.verbose });
        return;
      }
      await listCameras();
    });

  camera
    .command("info")
    .description("Show stored camera inventory diagnostics for a registered node")
    .requiredOption("--node <name>", "Registered node name, e.g. greenhouse-zero")
    .option("--json", "Print structured JSON")
    .action(async (options: { node: string; json?: boolean }) => {
      const nodes = await listNodeCameras(prisma, options.node);
      if (options.json) {
        console.log(JSON.stringify(nodeInventoryJson(nodes), null, 2));
        return;
      }
      if (nodes.length === 0) {
        console.log(`No registered node named "${options.node}".`);
        process.exitCode = 1;
        return;
      }
      printNodeCameraInventory(nodes, { verbose: true });
    });

  camera
    .command("refresh")
    .description("Request an immediate camera inventory refresh from a registered node and print the resulting stored modes")
    .requiredOption("--node <name>", "Registered node name, e.g. greenhouse-zero")
    .option("--timeout-ms <ms>", "How long to wait for a newer inventory report", (value) => Number(value), 45_000)
    .option("--poll-ms <ms>", "Polling interval while waiting", (value) => Number(value), 1500)
    .option("--json", "Print structured JSON")
    .action(async (options: { node: string; timeoutMs: number; pollMs: number; json?: boolean }) => {
      const before = await prisma.plantLabNode.findUnique({ where: { name: options.node } });
      if (!before) {
        console.log(`No registered node named "${options.node}".`);
        process.exitCode = 1;
        return;
      }
      const requested = await requestCameraInventoryRefresh(prisma, options.node);
      const started = Date.now();
      let current = requested;
      while (Date.now() - started < options.timeoutMs) {
        current = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: requested.id } });
        if (current.lastInventoryAt && current.lastInventoryAt > requested.inventoryRefreshRequestedAt!) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      }

      const nodes = await listNodeCameras(prisma, options.node);
      if (options.json) {
        console.log(JSON.stringify({ refreshed: current.inventoryRefreshRequestedAt === null, requestedAt: requested.inventoryRefreshRequestedAt, nodes: nodeInventoryJson(nodes) }, null, 2));
      } else {
        if (current.inventoryRefreshRequestedAt !== null) {
          console.log(`Timed out waiting for ${options.node} to report fresh inventory. Current stored inventory follows.`);
        }
        printNodeCameraInventory(nodes, { verbose: true });
      }
      if (current.inventoryRefreshRequestedAt !== null) process.exitCode = 1;
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
      async (options: CameraAttachOptions) => {
        try {
          const result = await runCameraAttachFlow(options);
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log("Camera attached.");
            console.log(`Node: ${result.node.name}`);
            console.log(`Camera: ${nodeCameraDisplayName(result.camera)}`);
            console.log(`CaptureSource: ${result.captureSource.name}`);
            console.log(`Mode: ${result.assignment.inputFormat.toUpperCase()} ${result.assignment.width}x${result.assignment.height}`);
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
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

  const sources = camera.command("sources").description("Manage capture sources across the coordinator");
  sources
    .command("doctor")
    .description("Scan capture sources for ones that look accidental or unused (e.g. left over from a failed onboarding)")
    .option("--yes", "Report findings without prompting for action")
    .option("--json", "Print structured JSON")
    .action(async (options: { yes?: boolean; json?: boolean }) => {
      const suspicious = await findSuspiciousCaptureSources(prisma);
      if (options.json) {
        console.log(JSON.stringify(suspicious, null, 2));
        return;
      }
      if (suspicious.length === 0) {
        console.log("No suspicious capture sources found.");
        return;
      }
      console.log(`Found ${suspicious.length} capture source(s) that may be accidental or unused:`);
      const canPrompt = Boolean(process.stdin.isTTY) && !options.yes;
      for (const inspection of suspicious) {
        console.log("");
        printCaptureSourceInspection(inspection);
        if (canPrompt) {
          await guideCaptureSourceAction(inspection, ask);
        }
      }
      if (!canPrompt) {
        console.log('\nRun "plantlab camera source inspect <id>" to review and act on one of these.');
      }
    });

  const source = camera.command("source").description("Inspect a single capture source");
  source
    .command("inspect")
    .description("Show detail for one capture source and, if it looks accidental, offer to rename, delete, or leave it")
    .argument("<id-or-name>", "Capture source id or exact name")
    .option("--yes", "Report findings without prompting for action")
    .option("--rename <name>", "Rename this source directly, without the interactive menu (for scripting/non-TTY use)")
    .option("--json", "Print structured JSON")
    .action(async (idOrName: string, options: { yes?: boolean; rename?: string; json?: boolean }) => {
      const inspection = await inspectCaptureSourceByIdOrName(prisma, idOrName);
      if (options.rename) {
        const renamed = await renameCaptureSource(prisma, inspection.source.id, options.rename);
        if (options.json) {
          console.log(JSON.stringify({ ...inspection, source: renamed }, null, 2));
        } else {
          console.log(`Renamed "${inspection.source.name}" to "${renamed.name}".`);
        }
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(inspection, null, 2));
        return;
      }
      printCaptureSourceInspection(inspection);
      const canPrompt = Boolean(process.stdin.isTTY) && !options.yes;
      if (canPrompt) {
        // Rename/leave-unchanged are always safe, and delete self-guards on
        // emptiness (guideCaptureSourceAction/deleteEmptyCaptureSource) -
        // the guided menu is offered for any explicitly-inspected source,
        // not just ones the automatic scan flagged as suspicious, so a
        // source that started out accidental but has since picked up real
        // activity (e.g. "2") can still be renamed to something meaningful.
        await guideCaptureSourceAction(inspection, ask);
      } else if (inspection.suspicious) {
        console.log('\nRun without --yes in an interactive session to rename, delete, or leave this unchanged.');
      }
    });
}
