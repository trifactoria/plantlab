import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveAllPaths, resolveRootDir } from "../paths.server";
import { checkExecutable, checkWritableDirectory } from "../startupChecks";
import { resolveNodeConfigPath, type NodeRole, writeNodeConfig } from "./config";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/operations/install.ts touches the filesystem and spawns processes - it must never be imported from a Client Component or run in a browser.",
  );
}

export type InstallOptions = {
  role: NodeRole;
  coordinatorUrl?: string | null;
  /** Skip generating systemd units - useful in a dev sandbox or CI where no systemd user session exists. */
  skipSystemd?: boolean;
};

export type InstallStep = { name: string; ok: boolean; detail: string };

export type InstallResult = {
  role: NodeRole;
  configPath: string;
  steps: InstallStep[];
  ok: boolean;
};

/**
 * Establishes the install architecture without trying to do every future
 * installation task (see ARCHITECTURE.md): validates the dependencies
 * `plantlab doctor` also checks (reused, not re-implemented), prepares
 * every data/backup/lock/ingest directory, records the chosen role in
 * plantlab.config.json, and - unless skipped - shells out to the existing,
 * already-reviewed deploy/systemd/install.sh for unit generation rather
 * than re-implementing systemd templating here. Coordinator registration
 * stays manual, exactly as this task's spec allows.
 */
export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const steps: InstallStep[] = [];

  const ffmpeg = await checkExecutable("ffmpeg", true);
  steps.push({ name: "dependency:ffmpeg", ok: ffmpeg.status !== "fail", detail: ffmpeg.detail });

  const v4l2ctl = await checkExecutable("v4l2-ctl", false);
  steps.push({ name: "dependency:v4l2-ctl", ok: true, detail: v4l2ctl.detail });

  const paths = resolveAllPaths();
  for (const [name, dir] of Object.entries(paths)) {
    if (name === "rootDir" || name === "dataDir") continue; // parent umbrella dirs - their children are checked individually below
    const result = await checkWritableDirectory(name, dir);
    steps.push({ name: `directory:${name}`, ok: result.status !== "fail", detail: result.detail });
  }

  const config = await writeNodeConfig(options.role, { coordinatorUrl: options.coordinatorUrl });
  steps.push({ name: "node-config", ok: true, detail: `role="${config.role}" recorded for this node.` });

  if (options.skipSystemd) {
    steps.push({ name: "systemd-units", ok: true, detail: "Skipped (--skip-systemd)." });
  } else {
    const scriptPath = path.join(resolveRootDir(), "deploy", "systemd", "install.sh");
    if (!existsSync(scriptPath)) {
      steps.push({ name: "systemd-units", ok: false, detail: `deploy/systemd/install.sh not found at ${scriptPath}.` });
    } else {
      const result = spawnSync("bash", [scriptPath], { cwd: resolveRootDir(), stdio: "inherit" });
      steps.push({
        name: "systemd-units",
        ok: result.status === 0,
        detail: result.status === 0 ? "Generated systemd user units (see output above)." : `install.sh exited with status ${result.status}.`,
      });
    }
  }

  return {
    role: options.role,
    configPath: resolveNodeConfigPath(),
    steps,
    ok: steps.every((s) => s.ok),
  };
}
