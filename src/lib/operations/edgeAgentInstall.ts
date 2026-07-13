// Remote installation of the lightweight Python edge agent (Parts 11-12 of
// the Pi Zero edge-agent task) - deliberately separate from
// roleConvergence.ts, which only knows how to converge the full
// Node.js/systemd agent stack. A Pi-Zero-class device never gets that
// stack at all; see remoteNode.ts computeFullAgentSupport() /
// recommendedRuntime for the decision and node.ts's attach flow for where
// this branches.
//
// Deployment model (Part 12): the small edge-agent/ directory is copied
// wholesale over SSH - never the full repository, never Docker. Re-running
// this always removes and recreates ~/plantlab-edge-agent (the *code*
// directory only) for a clean, idempotent copy; durable state
// (config/credential/spool) lives elsewhere
// (~/.config/plantlab, ~/.local/state/plantlab-edge-agent) and is never
// touched by this.

import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { runLocalCommand, runRemoteShell, validateSshHost, type CommandResult } from "./shellExec";
import { shellQuote } from "./systemdUnits";
import {
  mergeEdgeAgentConfig,
  type EdgeConfigMergeInput,
  type GreenhousePowerConfig,
  type GreenhouseSensorConfig,
} from "./greenhouseConfig";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/edgeAgentInstall.ts shells out to scp/ssh and must not run in a browser.");
}

const REMOTE_EDGE_AGENT_DIR = "plantlab-edge-agent";

export function localEdgeAgentDir(): string {
  return path.join(process.cwd(), "edge-agent");
}

export type EdgeAgentVersionInfo = {
  version: string | null;
  commit: string | null;
  contentHash: string | null;
  raw?: unknown;
};

export function edgeAgentInstallChangeStatus(source: EdgeAgentVersionInfo, installedBefore: EdgeAgentVersionInfo | null): "UPDATED" | "UNCHANGED" {
  return installedBefore?.contentHash && source.contentHash && installedBefore.contentHash === source.contentHash ? "UNCHANGED" : "UPDATED";
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") continue;
      files.push(...(await walkFiles(root, fullPath)));
    } else if (entry.isFile()) {
      const rel = path.relative(root, fullPath).split(path.sep).join("/");
      if (rel.endsWith(".pyc") || rel === "_install_meta.py") continue;
      files.push(fullPath);
    }
  }
  return files;
}

async function hashPackageDirectory(packageDir: string): Promise<string> {
  const digest = createHash("sha256");
  const files = (await walkFiles(packageDir)).sort();
  for (const file of files) {
    const rel = path.relative(packageDir, file).split(path.sep).join("/");
    digest.update(rel);
    digest.update("\0");
    digest.update(await readFile(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function parsePackageVersion(pyproject: string): string | null {
  return /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? null;
}

export async function localEdgeAgentVersion(): Promise<EdgeAgentVersionInfo> {
  const root = localEdgeAgentDir();
  const packageDir = path.join(root, "plantlab_edge_agent");
  const pyproject = await readFile(path.join(root, "pyproject.toml"), "utf8").catch(() => "");
  const commitResult = await runLocalCommand("git", ["-C", process.cwd(), "rev-parse", "HEAD"], { timeoutMs: 5_000 }).catch(() => null);
  return {
    version: parsePackageVersion(pyproject),
    commit: commitResult?.status === 0 ? commitResult.stdout.trim() || null : null,
    contentHash: await hashPackageDirectory(packageDir),
  };
}

export async function readInstalledEdgeAgentVersion(sshHost: string): Promise<EdgeAgentVersionInfo | null> {
  validateSshHost(sshHost);
  const script = String.raw`
set -u
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
wrapper_path="$home_dir/.local/bin/plantlab-edge"
json=""
if command -v bash >/dev/null 2>&1; then
  json="$(bash -lc 'plantlab-edge version --json' 2>/dev/null || true)"
fi
if [ -z "$json" ] && [ -x "$wrapper_path" ]; then
  json="$("$wrapper_path" version --json 2>/dev/null || true)"
fi
[ -n "$json" ] || exit 44
printf '%s\n' "$json"
`;
  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: 15_000 }).catch(() => ({ stdout: "", stderr: "", status: 255 }));
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { version?: string; commit?: string; contentHash?: string };
    return {
      version: parsed.version ?? null,
      commit: parsed.commit ?? null,
      contentHash: parsed.contentHash ?? null,
      raw: parsed,
    };
  } catch {
    return null;
  }
}

/** Copies edge-agent/ over SSH via scp (rsync isn't guaranteed present on Raspberry Pi OS Lite; scp ships with openssh-client, which SSH access itself already requires). */
export async function copyEdgeAgentDirectory(sshHost: string): Promise<CommandResult> {
  validateSshHost(sshHost);
  // Clean slate first so a re-copy is a true mirror, never a stale merge -
  // safe because this only ever touches the *code* directory, never
  // config/credential/spool (see module doc comment).
  const cleanResult = await runRemoteShell(sshHost, `rm -rf ~/${REMOTE_EDGE_AGENT_DIR}`, [], { timeoutMs: 15_000 });
  if (cleanResult.status !== 0) {
    return cleanResult;
  }
  return runLocalCommand("scp", ["-r", "-o", "BatchMode=yes", localEdgeAgentDir(), `${sshHost}:${REMOTE_EDGE_AGENT_DIR}`], {
    timeoutMs: 60_000,
  });
}

export type EdgeAgentInstallInput = {
  role: "camera-node" | "greenhouse-node";
  nodeName: string;
  coordinatorUrl: string;
  spoolRoot?: string | null;
};

/** Runs install.sh remotely - non-interactive by construction (install.sh never prompts; role/node-name/coordinator-url are passed as env vars). Never creates a credential - see install.sh's own doc comment. */
export async function runEdgeAgentInstall(sshHost: string, input: EdgeAgentInstallInput): Promise<CommandResult> {
  validateSshHost(sshHost);
  const source = await localEdgeAgentVersion();
  const env = [
    `PLANTLAB_EDGE_ROLE=${shellQuote(input.role)}`,
    `PLANTLAB_EDGE_NODE_NAME=${shellQuote(input.nodeName)}`,
    `PLANTLAB_EDGE_COORDINATOR_URL=${shellQuote(input.coordinatorUrl)}`,
    input.spoolRoot ? `PLANTLAB_EDGE_SPOOL_ROOT=${shellQuote(input.spoolRoot)}` : "",
    source.contentHash ? `PLANTLAB_EDGE_SOURCE_HASH=${shellQuote(source.contentHash)}` : "",
    source.commit ? `PLANTLAB_EDGE_SOURCE_COMMIT=${shellQuote(source.commit)}` : "",
  ].filter(Boolean);
  const script = `cd ~/${REMOTE_EDGE_AGENT_DIR} && ${env.join(" ")} sh install.sh`;
  return runRemoteShell(sshHost, script, [], { timeoutMs: 120_000 });
}

export type EdgeCommandVerification = {
  /** True only if `command -v plantlab-edge` resolves in a *real* fresh login shell (bash -l) - a plain non-interactive `ssh host cmd` never sources ~/.profile/~/.bashrc, so that alone is never used as evidence either way (Part 3). */
  resolvesInLoginShell: boolean;
  /** The absolute path a login shell resolves `plantlab-edge` to, when it does. */
  resolvedPath: string | null;
  /** The install location the wrapper script should exist at regardless of PATH - always reported so the coordinator can show it even when PATH resolution fails. */
  wrapperPath: string;
  wrapperExists: boolean;
};

/**
 * Verifies the `plantlab-edge` command is actually usable after install -
 * Part 3: "Coordinator-side attachment must verify the edge command after
 * installation and display its exact path." Checks the wrapper file
 * exists on disk *and* separately whether it resolves via PATH in a real
 * login shell (`bash -lc` - not just a plain non-interactive SSH command,
 * which never sources shell startup files regardless of PATH edits).
 */
export async function verifyEdgeCommand(sshHost: string, remoteUser?: string | null): Promise<EdgeCommandVerification> {
  validateSshHost(sshHost);
  const script = String.raw`
set -u
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
wrapper_path="$home_dir/.local/bin/plantlab-edge"
wrapper_exists=false
[ -x "$wrapper_path" ] && wrapper_exists=true
resolved=""
if command -v bash >/dev/null 2>&1; then
  resolved="$(bash -lc 'command -v plantlab-edge' 2>/dev/null || true)"
fi
printf 'WRAPPER_PATH=%s\n' "$wrapper_path"
printf 'WRAPPER_EXISTS=%s\n' "$wrapper_exists"
printf 'RESOLVED=%s\n' "$resolved"
`;
  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: 15_000 }).catch(() => ({ stdout: "", stderr: "", status: 255 }));
  const wrapperPathMatch = /^WRAPPER_PATH=(.*)$/m.exec(result.stdout);
  const wrapperExistsMatch = /^WRAPPER_EXISTS=(.*)$/m.exec(result.stdout);
  const resolvedMatch = /^RESOLVED=(.*)$/m.exec(result.stdout);
  const resolvedPath = resolvedMatch?.[1]?.trim() || null;
  return {
    resolvesInLoginShell: Boolean(resolvedPath),
    resolvedPath,
    wrapperPath: wrapperPathMatch?.[1]?.trim() || `/home/${remoteUser || sshHost}/.local/bin/plantlab-edge`,
    wrapperExists: wrapperExistsMatch?.[1]?.trim() === "true",
  };
}

export type EdgeConfigConvergenceResult = {
  ok: boolean;
  status: "UNCHANGED" | "UPDATED" | "FAILED";
  configPath: string | null;
  spoolRoot: string | null;
  detail: string;
  stdout: string;
  stderr: string;
};

export type RemoteEdgeAgentConfig = {
  configPath: string | null;
  exists: boolean;
  config: Record<string, unknown>;
  error: string | null;
};

export async function readRemoteEdgeAgentConfig(sshHost: string): Promise<RemoteEdgeAgentConfig> {
  validateSshHost(sshHost);
  const script = String.raw`
set -u
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
config_path="$home_dir/.config/plantlab/edge-agent.json"
python3 - "$config_path" <<'PY'
import json, os, sys
path = sys.argv[1]
payload = {"configPath": path, "exists": os.path.exists(path), "config": {}, "error": None}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            payload["config"] = parsed
        else:
            payload["error"] = "edge-agent.json must contain a JSON object"
    except Exception as exc:
        payload["error"] = str(exc)
print(json.dumps(payload))
PY
`;
  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: 15_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not read remote edge-agent config.");
  }
  const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as RemoteEdgeAgentConfig;
  return {
    configPath: typeof parsed.configPath === "string" ? parsed.configPath : null,
    exists: parsed.exists === true,
    config: parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config) ? parsed.config : {},
    error: typeof parsed.error === "string" && parsed.error.trim() ? parsed.error : null,
  };
}

export type GreenhouseSecretStatus = {
  path: string | null;
  exists: boolean;
  mode: string | null;
};

export async function readRemoteGreenhouseSecretStatus(sshHost: string): Promise<GreenhouseSecretStatus> {
  validateSshHost(sshHost);
  const script = String.raw`
set -u
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
secret_path="$home_dir/.config/plantlab/greenhouse.env"
exists=false; [ -f "$secret_path" ] && exists=true
mode=""; [ -e "$secret_path" ] && mode="$(stat -c '%a' "$secret_path" 2>/dev/null || true)"
python3 - "$secret_path" "$exists" "$mode" <<'PY'
import json, sys
path, exists, mode = sys.argv[1:4]
print(json.dumps({"path": path, "exists": exists == "true", "mode": mode or None}))
PY
`;
  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: 15_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not inspect remote greenhouse secret file.");
  }
  const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as GreenhouseSecretStatus;
  return {
    path: typeof parsed.path === "string" ? parsed.path : null,
    exists: parsed.exists === true,
    mode: typeof parsed.mode === "string" ? parsed.mode : null,
  };
}

export async function writeRemoteGreenhouseSecrets(
  sshHost: string,
  secrets: { kasaUsername: string; kasaPassword: string },
): Promise<CommandResult> {
  validateSshHost(sshHost);
  if (secrets.kasaUsername.includes("\n") || secrets.kasaPassword.includes("\n")) {
    throw new Error("Greenhouse secret values must not contain newlines.");
  }
  const payload = Buffer.from(
    `KASA_USERNAME=${dotenvQuote(secrets.kasaUsername)}\nKASA_PASSWORD=${dotenvQuote(secrets.kasaPassword)}\n`,
    "utf8",
  ).toString("base64");
  const script = String.raw`
set -eu
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
env_dir="$home_dir/.config/plantlab"
secret_path="$env_dir/greenhouse.env"
payload_b64=__PAYLOAD__
mkdir -p "$env_dir"
chmod 700 "$env_dir"
python3 - "$secret_path" "$payload_b64" <<'PY'
import base64, os, sys
path, payload_b64 = sys.argv[1:3]
payload = base64.b64decode(payload_b64.encode("ascii"))
tmp = f"{path}.tmp-{os.getpid()}"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
try:
    with os.fdopen(fd, "wb") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
mode="$(stat -c '%a' "$secret_path")"
if [ "$mode" != "600" ]; then echo "Greenhouse secret file mode is $mode, expected 600" >&2; exit 23; fi
printf 'greenhouse.env written\n'
`.replace("__PAYLOAD__", shellQuote(payload));
  return runRemoteShell(sshHost, script, [], { timeoutMs: 15_000 });
}

function dotenvQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type EdgeConfigConvergenceInput = Omit<EdgeConfigMergeInput, "spoolRoot" | "cameraEnabled" | "sensors" | "power"> & {
  spoolRoot?: string | null;
  cameraEnabled?: boolean;
  capabilities?: string[];
  sensors?: GreenhouseSensorConfig[] | null;
  power?: GreenhousePowerConfig | null;
};

export async function convergeEdgeAgentConfig(
  sshHost: string,
  input: EdgeConfigConvergenceInput,
): Promise<EdgeConfigConvergenceResult> {
  validateSshHost(sshHost);
  const read = await readRemoteEdgeAgentConfig(sshHost);
  const spoolRoot = input.spoolRoot ?? read.config.spoolRoot ?? read.config.spool_root ?? "";
  const merged = mergeEdgeAgentConfig(read.config, {
    role: input.role,
    nodeName: input.nodeName,
    coordinatorUrl: input.coordinatorUrl,
    spoolRoot: typeof spoolRoot === "string" && spoolRoot.trim() ? spoolRoot.trim() : "",
    cameraEnabled: input.cameraEnabled ?? (input.capabilities ?? ["camera"]).includes("camera"),
    sensors: input.sensors,
    power: input.power,
    disableSensors: input.disableSensors,
    disablePower: input.disablePower,
  });
  const payload = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8").toString("base64");
  const script = String.raw`
set -eu
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
config_dir="$home_dir/.config/plantlab"
config_path="$config_dir/edge-agent.json"
spool_root=__SPOOL_ROOT__
payload_b64=__PAYLOAD__
if [ -z "$spool_root" ]; then spool_root="$home_dir/.local/state/plantlab-edge-agent"; fi
mkdir -p "$config_dir" "$spool_root/spool/pending" "$spool_root/spool/uploading" "$spool_root/spool/acknowledged" "$spool_root/spool/failed" "$spool_root/logs"
chmod 700 "$config_dir"
python3 - "$config_path" "$payload_b64" "$spool_root" <<'PY'
import base64, json, os, sys
path, payload_b64, spool_root = sys.argv[1:4]
payload_bytes = base64.b64decode(payload_b64.encode("ascii"))
payload = json.loads(payload_bytes.decode("utf-8"))
if not payload.get("coordinatorUrl"):
    raise SystemExit("coordinatorUrl is empty")
if not payload.get("spoolRoot"):
    payload["spoolRoot"] = spool_root
    payload_bytes = (json.dumps(payload, indent=2) + "\n").encode("utf-8")
try:
    with open(path, "rb") as f:
        existing_bytes = f.read()
except Exception:
    existing_bytes = b""
changed = existing_bytes != payload_bytes
if changed:
    tmp = f"{path}.tmp-{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload_bytes)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
with open(path, "r", encoding="utf-8") as f:
    parsed = json.load(f)
if not parsed.get("coordinatorUrl"):
    raise SystemExit("coordinatorUrl is still empty after convergence")
print(json.dumps({"changed": changed, "configPath": path, "spoolRoot": parsed.get("spoolRoot")}))
PY
`
    .replace("__SPOOL_ROOT__", shellQuote(typeof merged.spoolRoot === "string" ? merged.spoolRoot : ""))
    .replace("__PAYLOAD__", shellQuote(payload));

  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: 20_000 });
  if (result.status !== 0) {
    return {
      ok: false,
      status: "FAILED",
      configPath: null,
      spoolRoot: null,
      detail: (result.stderr.trim() || result.stdout.trim() || "Edge config convergence failed.").slice(0, 2000),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  let parsed: { changed?: boolean; configPath?: string; spoolRoot?: string } = {};
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    parsed = {};
  }
  return {
    ok: true,
    status: parsed.changed ? "UPDATED" : "UNCHANGED",
    configPath: parsed.configPath ?? null,
    spoolRoot: parsed.spoolRoot ?? null,
    detail: parsed.changed ? "edge-agent.json updated." : "edge-agent.json already matched coordinator values.",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
