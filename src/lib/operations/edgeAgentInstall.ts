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
import { resolveRootDir } from "../paths.server";
import { runLocalCommand, runRemoteShell, validateSshHost, type CommandResult } from "./shellExec";
import { shellQuote } from "./systemdUnits";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/edgeAgentInstall.ts shells out to scp/ssh and must not run in a browser.");
}

const REMOTE_EDGE_AGENT_DIR = "plantlab-edge-agent";

export function localEdgeAgentDir(): string {
  return path.join(resolveRootDir(), "edge-agent");
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
  const script = [
    `cd ~/${REMOTE_EDGE_AGENT_DIR}`,
    `PLANTLAB_EDGE_ROLE=${shellQuote(input.role)}`,
    `PLANTLAB_EDGE_NODE_NAME=${shellQuote(input.nodeName)}`,
    `PLANTLAB_EDGE_COORDINATOR_URL=${shellQuote(input.coordinatorUrl)}`,
    input.spoolRoot ? `PLANTLAB_EDGE_SPOOL_ROOT=${shellQuote(input.spoolRoot)}` : "",
    "sh install.sh",
  ].filter(Boolean).join(" ");
  return runRemoteShell(sshHost, script, [], { timeoutMs: 120_000 });
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

export async function convergeEdgeAgentConfig(
  sshHost: string,
  input: {
    role: "camera-node" | "greenhouse-node";
    nodeName: string;
    coordinatorUrl: string;
    spoolRoot?: string | null;
    capabilities?: string[];
  },
): Promise<EdgeConfigConvergenceResult> {
  validateSshHost(sshHost);
  const capabilities = JSON.stringify(input.capabilities ?? ["camera"]);
  const script = String.raw`
set -eu
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
config_dir="$home_dir/.config/plantlab"
config_path="$config_dir/edge-agent.json"
role=__ROLE__
node_name=__NODE_NAME__
coordinator_url=__COORDINATOR_URL__
spool_root=__SPOOL_ROOT__
capabilities_json=__CAPABILITIES__
if [ -z "$coordinator_url" ]; then echo "coordinatorUrl is empty" >&2; exit 30; fi
if [ -z "$spool_root" ]; then spool_root="$home_dir/.local/state/plantlab-edge-agent"; fi
mkdir -p "$config_dir" "$spool_root/spool/pending" "$spool_root/spool/uploading" "$spool_root/spool/acknowledged" "$spool_root/spool/failed" "$spool_root/logs"
chmod 700 "$config_dir"
python3 - "$config_path" "$role" "$node_name" "$coordinator_url" "$spool_root" "$capabilities_json" <<'PY'
import json, os, sys
path, role, node_name, coordinator_url, spool_root, capabilities_json = sys.argv[1:7]
try:
    capabilities = json.loads(capabilities_json)
except Exception:
    capabilities = ["camera"]
try:
    with open(path, "r", encoding="utf-8") as f:
        existing = json.load(f)
except Exception:
    existing = {}
payload = {
    "role": role,
    "nodeName": node_name,
    "coordinatorUrl": coordinator_url,
    "spoolRoot": spool_root,
    "capabilities": capabilities,
    "heartbeatIntervalSeconds": int(existing.get("heartbeatIntervalSeconds", 30)),
    "pollIntervalSeconds": int(existing.get("pollIntervalSeconds", 5)),
    "maxSpoolBytes": int(existing.get("maxSpoolBytes", 536870912)),
    "maxUploadBytes": int(existing.get("maxUploadBytes", 8388608)),
}
changed = existing != payload
if changed:
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    os.chmod(path, 0o600)
with open(path, "r", encoding="utf-8") as f:
    parsed = json.load(f)
if not parsed.get("coordinatorUrl"):
    raise SystemExit("coordinatorUrl is still empty after convergence")
print(json.dumps({"changed": changed, "configPath": path, "spoolRoot": parsed.get("spoolRoot")}))
PY
`
    .replace("__ROLE__", shellQuote(input.role))
    .replace("__NODE_NAME__", shellQuote(input.nodeName))
    .replace("__COORDINATOR_URL__", shellQuote(input.coordinatorUrl))
    .replace("__SPOOL_ROOT__", shellQuote(input.spoolRoot ?? ""))
    .replace("__CAPABILITIES__", shellQuote(capabilities));

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
