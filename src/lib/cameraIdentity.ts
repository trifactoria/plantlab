import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type UsbIdentity = {
  vendorId: string | null;
  productId: string | null;
  serial: string | null;
  physicalPath: string | null;
  usbPath: string | null;
  idPathTag: string | null;
  devpath: string | null;
  busInfo: string | null;
};

async function readSysfsAttribute(dir: string, name: string): Promise<string | null> {
  try {
    const content = await readFile(path.join(dir, name), "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function readBusInfo(device: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("v4l2-ctl", ["-d", device, "--info"], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      const match = /Bus info\s*:\s*(\S+)/.exec(stdout.toString());
      resolve(match ? match[1] : null);
    });
  });
}

function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

async function readUdevProperties(device: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile("udevadm", ["info", "--query=property", "--name", device], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve({});
        return;
      }
      resolve(parseProperties(stdout.toString()));
    });
  });
}

export function normalizeUsbPhysicalPath(value: string | null | undefined): string | null {
  let normalized = value?.trim();
  if (!normalized) return null;

  normalized = normalized
    .replace(/\/video4linux\/video\d+$/i, "")
    .replace(/(\d+-\d+(?:\.\d+)*):\d+\.\d+$/i, "$1")
    .replace(/(:\d+(?:\.\d+)+):\d+\.\d+$/i, "$1");

  return normalized || null;
}

export function usbPathSuffix(physicalPath: string | null | undefined): string | null {
  const normalized = normalizeUsbPhysicalPath(physicalPath);
  if (!normalized) return null;

  const colonPort = /:(\d+(?:\.\d+)*)$/.exec(normalized);
  if (colonPort) return colonPort[1];

  const sysfsPort = /\d+-(\d+(?:\.\d+)*)$/.exec(normalized);
  if (sysfsPort) return sysfsPort[1];

  const finalSegment = normalized.split("/").filter(Boolean).at(-1);
  return finalSegment ?? normalized;
}

function identitySerialKey(identity: Pick<UsbIdentity, "vendorId" | "productId" | "serial">): string | null {
  if (!identity.vendorId || !identity.productId || !identity.serial) return null;
  return `${identity.vendorId}:${identity.productId}:${identity.serial}`;
}

export function duplicatedSerialKeys(identities: UsbIdentity[]): Set<string> {
  const pathsBySerial = new Map<string, Set<string>>();
  for (const identity of identities) {
    const key = identitySerialKey(identity);
    if (!key) continue;
    const disambiguator = identity.physicalPath ?? identity.usbPath ?? identity.busInfo;
    if (!disambiguator) continue;
    const paths = pathsBySerial.get(key) ?? new Set<string>();
    paths.add(disambiguator);
    pathsBySerial.set(key, paths);
  }
  return new Set(Array.from(pathsBySerial.entries()).filter(([, paths]) => paths.size > 1).map(([key]) => key));
}

/**
 * Reads whatever stable identity information Linux exposes for a V4L2
 * device: USB vendor/product id and serial number, udev's physical port
 * path, and V4L2 bus info as a weaker fallback signal. Not every camera
 * reports all of these - many UVC cameras do not expose a trustworthy USB
 * serial number, and some duplicate the same fake serial across units.
 */
export async function readUsbIdentity(device: string): Promise<UsbIdentity> {
  const basename = path.basename(device);
  const deviceLink = `/sys/class/video4linux/${basename}/device`;

  let vendorId: string | null = null;
  let productId: string | null = null;
  let serial: string | null = null;
  let sysfsPhysicalPath: string | null = null;

  try {
    let dir = await realpath(deviceLink);

    for (let depth = 0; depth < 8; depth += 1) {
      const candidateVendor = await readSysfsAttribute(dir, "idVendor");
      if (candidateVendor) {
        vendorId = candidateVendor;
        productId = await readSysfsAttribute(dir, "idProduct");
        serial = await readSysfsAttribute(dir, "serial");
        sysfsPhysicalPath = path.basename(dir);
        break;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    // No sysfs entry (non-Linux, virtual device, or permissions) - the
    // caller falls back to bus info, or ultimately to manual selection.
  }

  const props = await readUdevProperties(device);
  vendorId = vendorId ?? props.ID_VENDOR_ID ?? null;
  productId = productId ?? props.ID_MODEL_ID ?? null;
  serial = serial ?? props.ID_SERIAL_SHORT ?? props.ID_SERIAL ?? null;
  const idPath = props.ID_PATH ?? null;
  const idPathTag = props.ID_PATH_TAG ?? null;
  const devpath = props.DEVPATH ?? null;
  const physicalPath = normalizeUsbPhysicalPath(idPath) ?? normalizeUsbPhysicalPath(devpath) ?? normalizeUsbPhysicalPath(sysfsPhysicalPath);
  const busInfo = await readBusInfo(device);

  return { vendorId, productId, serial, physicalPath, usbPath: physicalPath, idPathTag, devpath, busInfo };
}

export function legacyStableId(identity: Pick<UsbIdentity, "vendorId" | "productId" | "serial">): string | null {
  if (identity.vendorId && identity.productId) {
    return `usb:${identity.vendorId}:${identity.productId}:${identity.serial || "noserial"}`;
  }
  return null;
}

/**
 * Composes a single stable identity string from whatever was available.
 * Uses vendor+product+serial when the serial is unique, and includes the
 * normalized physical USB path when the serial is duplicated or missing.
 * Moving a camera to another USB port therefore changes identity when the
 * camera has no unique serial, which is intentional: the port path is the
 * only durable discriminator Linux exposes for identical/fake-serial UVC
 * devices.
 */
export function composeStableId(identity: UsbIdentity, options: { duplicateSerial?: boolean } = {}): string | null {
  const base = legacyStableId(identity);
  const pathDisambiguator = identity.physicalPath ?? identity.usbPath ?? identity.busInfo;

  if (base && (!identity.serial || options.duplicateSerial)) {
    return pathDisambiguator ? `${base}:path:${pathDisambiguator}` : base;
  }

  if (base && identity.serial) {
    return base;
  }

  if (identity.vendorId && identity.productId && pathDisambiguator) {
    return `usb:${identity.vendorId}:${identity.productId}:noserial:path:${pathDisambiguator}`;
  }

  return null;
}

// Pure matching logic lives in ./cameraIdentityMatch (no Node imports) so it
// can also run in the browser; re-exported here for server-side convenience.
export { matchSavedCamera, type DiscoveredCameraIdentity, type StableCameraMatch } from "./cameraIdentityMatch";
