import { execFile } from "node:child_process";

export type LocalCamera = {
  name: string;
  device: string;
  supportsCapture: boolean;
};

export type CameraControl = {
  id: string;
  name: string;
  type: "int" | "bool" | "menu" | "unknown";
  value: number | boolean | string;
  minimum?: number;
  maximum?: number;
  step?: number;
  defaultValue?: number | boolean | string;
  readOnly: boolean;
  options?: Array<{ value: number; label: string }>;
};

function execFileText(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.toString().trim() || error.message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
        return;
      }

      resolve(stdout.toString());
    });
  });
}

export async function discoverLocalCameras(): Promise<LocalCamera[]> {
  const output = await execFileText("v4l2-ctl", ["--list-devices"]);
  const cameras: LocalCamera[] = [];
  let currentName = "Unknown camera";

  for (const line of output.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    if (!line.startsWith("\t") && !line.startsWith(" ")) {
      currentName = line.replace(/\s+\([^)]*\):$/, "").replace(/:$/, "").trim();
      continue;
    }

    const device = line.trim();
    if (!device.startsWith("/dev/video")) {
      continue;
    }

    const supportsCapture = await deviceSupportsCapture(device).catch(() => false);
    cameras.push({ name: currentName, device, supportsCapture });
  }

  return cameras.sort((a, b) => {
    if (a.supportsCapture !== b.supportsCapture) {
      return a.supportsCapture ? -1 : 1;
    }

    return a.device.localeCompare(b.device, undefined, { numeric: true });
  });
}

async function deviceSupportsCapture(device: string) {
  const output = await execFileText("v4l2-ctl", ["-d", device, "--all"]);
  return /Video Capture|Video Capture Multiplanar/.test(output);
}

export async function listCameraControls(device: string): Promise<CameraControl[]> {
  const output = await execFileText("v4l2-ctl", ["-d", device, "--list-ctrls-menus"]);
  const controls: CameraControl[] = [];
  let currentMenuControl: CameraControl | null = null;

  for (const line of output.split("\n")) {
    const controlMatch = /^\s*([a-zA-Z0-9_]+)\s+0x[0-9a-fA-F]+\s+\(([^)]+)\)\s*:\s*(.*)$/.exec(line);
    const menuOptionMatch = /^\s+(\d+):\s*(.+)$/.exec(line);

    if (controlMatch) {
      const [, id, rawType, rawMeta] = controlMatch;
      const type = rawType === "integer" ? "int" : rawType === "boolean" ? "bool" : rawType === "menu" ? "menu" : "unknown";
      const meta = parseControlMeta(rawMeta);
      const value = type === "bool" ? meta.value === 1 : meta.value ?? "";
      const defaultValue = type === "bool" ? meta.defaultValue === 1 : meta.defaultValue;
      const control: CameraControl = {
        id,
        name: humanizeControlName(id),
        type,
        value,
        minimum: meta.minimum,
        maximum: meta.maximum,
        step: meta.step,
        defaultValue,
        readOnly: /read-only|inactive/.test(rawMeta),
        options: type === "menu" ? [] : undefined,
      };

      controls.push(control);
      currentMenuControl = type === "menu" ? control : null;
      continue;
    }

    if (menuOptionMatch && currentMenuControl?.options) {
      currentMenuControl.options.push({
        value: Number(menuOptionMatch[1]),
        label: menuOptionMatch[2].trim(),
      });
    }
  }

  return controls;
}

function parseControlMeta(rawMeta: string) {
  const numberFor = (key: string) => {
    const match = new RegExp(`${key}=(-?\\d+)`).exec(rawMeta);
    return match ? Number(match[1]) : undefined;
  };

  return {
    minimum: numberFor("min"),
    maximum: numberFor("max"),
    step: numberFor("step"),
    defaultValue: numberFor("default"),
    value: numberFor("value"),
  };
}

function humanizeControlName(id: string) {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function setCameraControl(device: string, control: string, value: string | number | boolean) {
  const normalizedValue = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  await execFileText("v4l2-ctl", ["-d", device, "--set-ctrl", `${control}=${normalizedValue}`]);
}
