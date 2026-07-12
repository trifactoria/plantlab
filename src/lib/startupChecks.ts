import { execFile } from "node:child_process";
import { access, constants, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
};

function pass(name: string, detail: string): CheckResult {
  return { name, status: "pass", detail };
}
function warn(name: string, detail: string): CheckResult {
  return { name, status: "warn", detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, status: "fail", detail };
}

/** Resolves an executable via the shell's own PATH lookup (`which`), so the reported path matches what child_process.spawn/execFile will actually run. */
export async function checkExecutable(command: string, required = true): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("which", [command], { timeout: 5_000 });
    const resolvedPath = stdout.trim();
    if (!resolvedPath) {
      throw new Error("empty output");
    }
    return pass(command, `Found at ${resolvedPath}`);
  } catch {
    const detail = `"${command}" was not found on PATH (current PATH: ${process.env.PATH ?? "(unset)"})`;
    return required ? fail(command, detail) : warn(command, detail);
  }
}

export async function checkWritableDirectory(name: string, dir: string): Promise<CheckResult> {
  const { mkdir } = await import("node:fs/promises");
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return pass(name, `Writable: ${dir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(name, `Not writable (${dir}): ${message}`);
  }
}

export async function checkVideoDevices(): Promise<CheckResult> {
  try {
    const entries = await readdir("/dev");
    const devices = entries.filter((entry) => entry.startsWith("video")).sort();
    if (devices.length === 0) {
      return warn("video-devices", "No /dev/video* devices found. Expected if no camera is attached yet.");
    }
    return pass("video-devices", `Found: ${devices.map((d) => `/dev/${d}`).join(", ")}`);
  } catch (error) {
    return fail("video-devices", error instanceof Error ? error.message : String(error));
  }
}

/**
 * The Ubuntu `video` group owns /dev/video* by default (mode 0660) - a
 * process running as a user who isn't a member can't open the device even
 * though it's physically present. `plugdev` is relevant for some USB
 * camera udev rules. Reads /etc/group directly rather than shelling out to
 * `id`, so this reflects group membership even before the current login
 * session picks up a just-added group (which normally requires re-login).
 *
 * Group membership is a good general-purpose signal, but it isn't the only
 * way a user can end up with access (e.g. a per-user ACL grant) - so this
 * first tries a real access probe against a detected /dev/video* device,
 * and only falls back to the group heuristic when there's no device to
 * probe against (e.g. no camera attached yet).
 */
export async function checkCameraGroupMembership(username = process.env.USER ?? ""): Promise<CheckResult> {
  try {
    const { access, constants: fsConstants } = await import("node:fs/promises");
    const entries = await readdir("/dev").catch(() => [] as string[]);
    const firstDevice = entries.filter((entry) => entry.startsWith("video")).sort()[0];

    if (firstDevice) {
      const devicePath = `/dev/${firstDevice}`;
      try {
        await access(devicePath, fsConstants.R_OK | fsConstants.W_OK);
        return pass("camera-groups", `Current process can read/write ${devicePath} directly.`);
      } catch {
        return fail(
          "camera-groups",
          `Current process cannot read/write ${devicePath}. Add the user to the video group: sudo usermod -aG video ${username || "<user>"} (then log out and back in).`,
        );
      }
    }
  } catch {
    // Fall through to the group-membership heuristic below.
  }

  if (!username) {
    return warn("camera-groups", "Could not determine the current username (process.env.USER is unset) and no /dev/video* device exists to probe.");
  }

  try {
    const { readFile } = await import("node:fs/promises");
    const groupFile = await readFile("/etc/group", "utf8");
    const memberOf = (groupName: string) =>
      groupFile
        .split("\n")
        .some((line) => {
          const [name, , , members] = line.split(":");
          return name === groupName && (members ?? "").split(",").includes(username);
        });

    const inVideo = memberOf("video");
    const inPlugdev = memberOf("plugdev");

    if (inVideo) {
      return pass("camera-groups", `User "${username}" is in the video group${inPlugdev ? " and plugdev" : ""}. (No /dev/video* device is present yet to verify directly.)`);
    }

    return warn(
      "camera-groups",
      `User "${username}" is not in the video group, and no /dev/video* device is present yet to verify directly. Once a camera is attached, re-run this check.`,
    );
  } catch (error) {
    return warn("camera-groups", `Could not read /etc/group: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkDatabaseConnectivity(prisma: { $queryRaw: (query: TemplateStringsArray) => Promise<unknown> }): Promise<CheckResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return pass("database", "Connected and responded to a query.");
  } catch (error) {
    return fail("database", error instanceof Error ? error.message : String(error));
  }
}

export function summarizeChecks(results: CheckResult[]): { ok: boolean; failCount: number; warnCount: number } {
  const failCount = results.filter((r) => r.status === "fail").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  return { ok: failCount === 0, failCount, warnCount };
}

export function formatCheckLine(result: CheckResult): string {
  const icon = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : "FAIL";
  return `[${icon}] ${result.name}: ${result.detail}`;
}
