import { checkExecutable, checkWritableDirectory } from "../startupChecks";
import { resolveAllPaths } from "../paths.server";
import { resolveNodeConfigPath, type NodeRole } from "./config";
import { applyMigrations } from "./migrations";
import { convergeNodeRole } from "./roleConvergence";

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
  /** Skip generating systemd units and starting services - useful in a dev sandbox or CI where no systemd user session exists. */
  skipSystemd?: boolean;
};

export type InstallStep = { name: string; ok: boolean; detail: string };

export type InstallResult = {
  role: NodeRole;
  configPath: string;
  steps: InstallStep[];
  ok: boolean;
};

const DOMAIN_DB_ROLES = new Set<NodeRole>(["coordinator", "standalone"]);

/**
 * Establishes the install architecture without trying to do every future
 * installation task (see ARCHITECTURE.md): validates the dependencies
 * `plantlab doctor` also checks (reused, not re-implemented), applies
 * pending migrations for a role that owns the canonical domain database
 * (see migrations.ts - a coordinator/standalone role must have its schema
 * current *before* web/camera ever starts), then delegates directory
 * preparation, systemd unit installation (mask-safe), and service
 * enable/start entirely to convergeNodeRole() - the same canonical
 * operation `plantlab node attach` and `plantlab doctor --fix` use, so
 * install never duplicates any of those rules (see Part 2 of the task this
 * was built for).
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

  if (DOMAIN_DB_ROLES.has(options.role)) {
    const migration = await applyMigrations();
    for (const step of migration.steps) {
      steps.push({ name: `migration:${step.name}`, ok: step.ok, detail: step.detail });
    }
    if (!migration.ok) {
      steps.push({ name: "migration-gate", ok: false, detail: "Migration did not succeed - refusing to start web/camera services against a stale or broken schema." });
      return { role: options.role, configPath: resolveNodeConfigPath(), steps, ok: false };
    }
  } else {
    steps.push({ name: "migrations", ok: true, detail: `Skipped - role "${options.role}" does not use the canonical domain database.` });
  }

  const convergence = await convergeNodeRole({
    target: { kind: "local" },
    role: options.role,
    coordinatorUrl: options.coordinatorUrl ?? null,
    startServices: !options.skipSystemd,
    manageSystemd: !options.skipSystemd,
  });
  for (const step of convergence.steps) {
    steps.push({ name: `service:${step.name}`, ok: step.status !== "failed", detail: step.detail });
  }

  return {
    role: options.role,
    configPath: resolveNodeConfigPath(),
    steps,
    ok: steps.every((s) => s.ok) && convergence.ok,
  };
}
