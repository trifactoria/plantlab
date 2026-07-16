// `plantlab update` - the code/schema/service upgrade phase, distinct from
// `plantlab install` (initial role setup) - see ARCHITECTURE.md /
// DEPLOYMENT.md "Canonical deployment paths". Idempotent and role-aware:
// a camera-node update never touches the canonical domain database or
// starts web/camera services (see migrations.ts's module doc comment for
// why), matching this task's Part 7/8 requirements exactly.
//
// Never runs `git pull` - see the task spec: "Do not automatically pull
// Git unless explicitly requested." The documented normal workflow is
// `git pull && plantlab update` as two explicit steps.

import { spawnSync } from "node:child_process";
import path from "node:path";
import packageJson from "../../../package.json";
import { resolveRootDir } from "../paths.server";
import { readNodeConfig, type NodeRole } from "./config";
import { applyMigrations } from "./migrations";
import { runDoctorReport } from "./doctor";
import { convergeNodeRole } from "./roleConvergence";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/update.ts spawns processes and must not run in a browser.");
}

export type UpdateOptions = {
  skipInstall?: boolean;
  skipBuild?: boolean;
  restartServices?: boolean;
};

export type UpdateStep = { name: string; ok: boolean; detail: string };
export type UpdateResult = { ok: boolean; role: NodeRole | null; steps: UpdateStep[] };

function runQuiet(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd: resolveRootDir(), encoding: "utf8" });
  const ok = result.status === 0;
  return { ok, output: ok ? "" : (result.stderr || result.stdout || `${command} exited with status ${result.status}`).slice(0, 2000) };
}

function gitDescribe(): string {
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: resolveRootDir(), encoding: "utf8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolveRootDir(), encoding: "utf8" });
  const commitStr = commit.status === 0 ? commit.stdout.trim() : "unknown";
  const branchStr = branch.status === 0 ? branch.stdout.trim() : "unknown";
  return `${branchStr}@${commitStr}`;
}

const DOMAIN_DB_ROLES = new Set<NodeRole>(["coordinator", "standalone"]);

/**
 * Brings THIS machine's code, schema, and services up to date for its
 * already-configured role. Requires `plantlab install` to have run first
 * (there is nothing to "update" without an existing role configuration).
 */
export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const steps: UpdateStep[] = [];

  steps.push({ name: "version", ok: true, detail: `plantlab ${packageJson.version} (${gitDescribe()})` });

  const config = await readNodeConfig();
  if (!config) {
    steps.push({ name: "configuration", ok: false, detail: 'No role is configured on this machine yet. Run "plantlab install" first.' });
    return { ok: false, role: null, steps };
  }
  steps.push({ name: "configuration", ok: true, detail: `role=${config.role}` });

  if (!options.skipInstall) {
    const install = runQuiet("pnpm", ["install", "--frozen-lockfile"]);
    steps.push({ name: "dependencies", ok: install.ok, detail: install.ok ? "Dependencies installed." : install.output });
    if (!install.ok) return { ok: false, role: config.role, steps };
  } else {
    steps.push({ name: "dependencies", ok: true, detail: "Skipped (--skip-install)." });
  }

  // Invokes the local prisma binary directly (same pattern as
  // migrations.ts) rather than `pnpm run db:generate` - this only needs
  // node_modules/.bin/prisma + prisma/schema.prisma, not a full pnpm
  // workspace/package.json resolution, and is what keeps this step
  // testable in isolation.
  const generate = runQuiet(path.join(resolveRootDir(), "node_modules", ".bin", "prisma"), ["generate"]);
  steps.push({ name: "prisma-client", ok: generate.ok, detail: generate.ok ? "Prisma client generated." : generate.output });
  if (!generate.ok) return { ok: false, role: config.role, steps };

  const touchesDomainDb = DOMAIN_DB_ROLES.has(config.role);
  if (touchesDomainDb) {
    const migration = await applyMigrations();
    for (const step of migration.steps) {
      steps.push({ name: `migration:${step.name}`, ok: step.ok, detail: step.detail });
    }
    if (!migration.ok) {
      steps.push({ name: "migration-gate", ok: false, detail: "Migration did not succeed - refusing to build/restart services against a stale or broken schema." });
      return { ok: false, role: config.role, steps };
    }
  } else {
    steps.push({
      name: "migrations",
      ok: true,
      detail: `Skipped - role "${config.role}" does not use the canonical domain database (see DEPLOYMENT.md "Database migration policy").`,
    });
  }

  if (!options.skipBuild && touchesDomainDb) {
    const build = runQuiet("pnpm", ["build"]);
    steps.push({ name: "build", ok: build.ok, detail: build.ok ? "Production build complete." : build.output });
    if (!build.ok) return { ok: false, role: config.role, steps };
  } else {
    steps.push({
      name: "build",
      ok: true,
      detail: touchesDomainDb ? "Skipped (--skip-build)." : `Skipped - role "${config.role}" does not run the web build.`,
    });
  }

  const convergence = await convergeNodeRole({
    target: { kind: "local" },
    role: config.role,
    coordinatorUrl: config.coordinatorUrl,
    nodeName: config.nodeName,
    spoolRoot: config.spoolRoot,
    // A routine update never rotates or rewrites the credential - only
    // `plantlab node attach --rotate-credential` or a doctor-driven repair
    // does that.
    credential: null,
    startServices: options.restartServices !== false,
    forceRestart: options.restartServices !== false,
  });
  for (const step of convergence.steps) {
    steps.push({ name: `service:${step.name}`, ok: step.status !== "failed", detail: step.detail });
  }
  if (!convergence.ok) {
    return { ok: false, role: config.role, steps };
  }

  const doctorReport = await runDoctorReport();
  steps.push({
    name: "doctor",
    ok: doctorReport.summary.failCount === 0,
    detail: `${doctorReport.summary.passCount} passed, ${doctorReport.summary.warnCount} warned, ${doctorReport.summary.failCount} failed.`,
  });

  return { ok: steps.every((step) => step.ok), role: config.role, steps };
}
