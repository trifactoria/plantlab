import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRootDir } from "../paths.server";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/operations/config.ts touches the filesystem - it must never be imported from a Client Component or run in a browser.",
  );
}

/**
 * PlantLab's roles as the platform grows from a single-machine app into a
 * multi-node system (see ARCHITECTURE.md). Only "standalone" has any real
 * behavioral effect today (none - every role currently behaves identically);
 * the others exist so `plantlab install`/`plantlab node` have a real,
 * durable place to record intent ahead of the actual capture-agent
 * protocol, which is explicitly out of scope for this task.
 */
export const NODE_ROLES = ["coordinator", "camera-node", "standalone", "microscope-node", "mobile-uploader", "greenhouse-node"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export function isValidNodeRole(value: unknown): value is NodeRole {
  return typeof value === "string" && (NODE_ROLES as readonly string[]).includes(value);
}

export type NodeConfig = {
  /** Config file format version - bump only on a breaking shape change. */
  formatVersion: 1;
  role: NodeRole;
  configuredAt: string;
  hostname: string;
  /**
   * Reserved for future coordinator registration (see ARCHITECTURE.md /
   * DEPLOYMENT.md "explicitly out of scope" - coordinator registration is
   * intentionally still manual in this task). Establishing this field now
   * gives future agent work a durable place to record it without another
   * config-format migration.
   */
  coordinatorUrl?: string | null;
  /** Human-facing coordinator-side node name, e.g. "xps". */
  nodeName?: string | null;
  /** Durable camera-node spool root. Defaults are role/runtime dependent. */
  spoolRoot?: string | null;
  /** Capabilities this node advertises - see capabilities.ts. Not authoritative on its own; the coordinator's PlantLabNode.capabilitiesJson (set from real heartbeats) is. */
  capabilities?: string[];
  /** Which agent implementation this node runs: the full TypeScript agent, or the lightweight Python edge agent (see edge-agent/). Written by roleConvergence.ts / the edge-agent installer, never inferred. */
  runtime?: "node" | "python-edge";
};

/** `<PLANTLAB_ROOT_DIR>/plantlab.config.json` - node-local, never synced, never part of a project backup archive. */
export function resolveNodeConfigPath(): string {
  return path.join(resolveRootDir(), "plantlab.config.json");
}

/** Returns null if no config has been written yet (before the first `plantlab install`) - never throws for a missing file. */
export async function readNodeConfig(): Promise<NodeConfig | null> {
  const configPath = resolveNodeConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as NodeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Writes atomically (temp file in the same directory, then rename) so a
 * reader (readNodeConfig, doctor, the camera-node agent runtime) never
 * observes a half-written file - a crash or concurrent read during the
 * write either sees the old config or the new one, never a truncated/
 * partial one. See DEPLOYMENT.md "Configuration must not remain
 * half-written".
 */
export async function writeNodeConfig(
  role: NodeRole,
  overrides: Partial<Pick<NodeConfig, "coordinatorUrl" | "nodeName" | "spoolRoot">> = {},
): Promise<NodeConfig> {
  const config: NodeConfig = {
    formatVersion: 1,
    role,
    configuredAt: new Date().toISOString(),
    hostname: os.hostname(),
    coordinatorUrl: overrides.coordinatorUrl ?? null,
    nodeName: overrides.nodeName ?? null,
    spoolRoot: overrides.spoolRoot ?? null,
  };

  await writeNodeConfigRaw(config);
  return config;
}

/** Lower-level atomic writer shared with roleConvergence.ts, which sometimes needs to write a config object it built itself (e.g. preserving fields writeNodeConfig()'s narrower signature doesn't accept). */
export async function writeNodeConfigRaw(config: NodeConfig): Promise<void> {
  const configPath = resolveNodeConfigPath();
  const tmpPath = path.join(path.dirname(configPath), `.plantlab.config.json.tmp-${randomUUID()}`);
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    await rename(tmpPath, configPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
