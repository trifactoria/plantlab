import { readFile, writeFile } from "node:fs/promises";
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
export const NODE_ROLES = ["coordinator", "camera-node", "standalone", "microscope-node", "mobile-uploader"] as const;
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

  await writeFile(resolveNodeConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}
