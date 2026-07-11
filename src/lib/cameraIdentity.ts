import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type UsbIdentity = {
  vendorId: string | null;
  productId: string | null;
  serial: string | null;
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

/**
 * Reads whatever stable identity information Linux exposes for a V4L2
 * device: USB vendor/product id and serial number (via sysfs, when the
 * device is USB-backed and the driver reports a serial), and V4L2 bus info
 * as a weaker fallback signal. Not every camera reports all of these -
 * many UVC cameras do not expose a USB serial number at all.
 */
export async function readUsbIdentity(device: string): Promise<UsbIdentity> {
  const basename = path.basename(device);
  const deviceLink = `/sys/class/video4linux/${basename}/device`;

  let vendorId: string | null = null;
  let productId: string | null = null;
  let serial: string | null = null;

  try {
    let dir = await realpath(deviceLink);

    for (let depth = 0; depth < 8; depth += 1) {
      const candidateVendor = await readSysfsAttribute(dir, "idVendor");
      if (candidateVendor) {
        vendorId = candidateVendor;
        productId = await readSysfsAttribute(dir, "idProduct");
        serial = await readSysfsAttribute(dir, "serial");
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

  const busInfo = await readBusInfo(device);

  return { vendorId, productId, serial, busInfo };
}

/**
 * Composes a single stable identity string from whatever was available.
 * Prefers vendor+product+serial (unique per physical unit); falls back to
 * vendor+product+bus-info (stable unless replugged into a different port);
 * returns null when neither is available, so callers fall back to manual
 * camera selection rather than guessing.
 */
export function composeStableId(identity: UsbIdentity): string | null {
  if (identity.vendorId && identity.productId && identity.serial) {
    return `usb:${identity.vendorId}:${identity.productId}:${identity.serial}`;
  }

  if (identity.vendorId && identity.productId && identity.busInfo) {
    return `usb:${identity.vendorId}:${identity.productId}:${identity.busInfo}`;
  }

  return null;
}

// Pure matching logic lives in ./cameraIdentityMatch (no Node imports) so it
// can also run in the browser; re-exported here for server-side convenience.
export { matchSavedCamera, type DiscoveredCameraIdentity, type StableCameraMatch } from "./cameraIdentityMatch";
