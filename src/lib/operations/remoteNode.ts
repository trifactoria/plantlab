// Remote host inspection and diagnostics only - see roleConvergence.ts for
// the actual convergence/repair operation (unit installation, mask
// recovery, config/credential writes, service enable/disable). Kept
// deliberately read-only/diagnostic so it never needs to duplicate any of
// roleConvergence.ts's rules.
import os from "node:os";
import packageJson from "../../../package.json";
import { resolveSshHost, runLocalCommand, runRemoteShell, validateSshHost, type CommandResult } from "./shellExec";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/remoteNode.ts shells out to ssh and must not run in a browser.");
}

export { runLocalCommand, runRemoteShell, validateSshHost, resolveSshHost, type CommandResult } from "./shellExec";

export type RemoteCheckStatus = "pass" | "warn" | "fail" | "not-installed" | "not-configured";

export type RemoteCheck = {
  name: string;
  status: RemoteCheckStatus;
  detail: string;
  suggestion?: string;
};

export type RemoteCameraInfo = {
  device: string;
  name: string | null;
  stableId: string | null;
  supportsCapture: boolean;
  formats?: unknown[];
};

export type RemoteInspection = {
  sshHost: string;
  resolvedHost: string | null;
  remoteHostname: string | null;
  remoteUser: string | null;
  operatingSystem: string | null;
  architecture: string | null;
  plantLabInstalled: boolean;
  plantLabVersion: string | null;
  repoPath: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  role: string | null;
  nodeVersion: string | null;
  pnpmAvailable: boolean;
  ffmpegAvailable: boolean;
  v4l2CtlAvailable: boolean;
  tailscaleInstalled: boolean;
  tailscaleConnected: boolean | null;
  tailscaleIPv4: string | null;
  lanIPv4Addresses: string[];
  bridgeIPv4Addresses: string[];
  otherIPv4Addresses: string[];
  ipv6Addresses: string[];
  freeDiskSpace: string | null;
  videoDevices: string[];
  cameras: RemoteCameraInfo[];
  services: {
    web: string | null;
    camera: string | null;
    agent: string | null;
  };
  coordinatorUrl: string | null;
  checks: RemoteCheck[];
  // Pi Zero feasibility fields (Part 5) - "architecture" above already
  // carries `uname -m` (e.g. "armv6l"); these are the additional facts
  // needed to decide whether the full Node.js agent is realistic on this
  // machine, plus the derived recommendation itself.
  armVersion: string | null;
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
  pythonVersion: string | null;
  /** Whether the full TypeScript/Next.js-adjacent agent stack is supported/recommended on this hardware - see computeFullAgentSupport(). */
  fullAgentSupported: boolean;
  recommendedRuntime: "node" | "python-edge";
  raw?: unknown;
};

const REMOTE_HOST_INSPECTION_TIMEOUT_MS = 60_000;

const INSPECT_SCRIPT = String.raw`
set -eu
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n'
}
cmd() { command -v "$1" >/dev/null 2>&1; }
first_existing_repo() {
  for p in "$HOME/projects/plantlab" "$HOME/plantlab" "$(pwd 2>/dev/null || printf '')"; do
    [ -n "$p" ] && [ -f "$p/package.json" ] && [ -f "$p/bin/plantlab" ] && printf '%s' "$p" && return 0
  done
  return 1
}
repo="$(first_existing_repo || true)"
role=""
coordinator=""
version=""
branch=""
commit=""
if [ -n "$repo" ]; then
  version="$(cd "$repo" && node -e "try { console.log(require('./package.json').version) } catch { process.exit(1) }" 2>/dev/null || true)"
  branch="$(cd "$repo" && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  commit="$(cd "$repo" && git rev-parse --short HEAD 2>/dev/null || true)"
  if [ -f "$repo/plantlab.config.json" ]; then
    role="$(node -e "const fs=require('fs'); const p=process.argv[1]; try { const c=JSON.parse(fs.readFileSync(p,'utf8')); console.log(c.role || '') } catch {}" "$repo/plantlab.config.json" 2>/dev/null || true)"
    coordinator="$(node -e "const fs=require('fs'); const p=process.argv[1]; try { const c=JSON.parse(fs.readFileSync(p,'utf8')); console.log(c.coordinatorUrl || '') } catch {}" "$repo/plantlab.config.json" 2>/dev/null || true)"
  fi
fi
os_pretty="$(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" || uname -s)"
arch="$(uname -m 2>/dev/null || true)"
node_version="$(node --version 2>/dev/null || true)"
python_version="$(python3 --version 2>&1 | awk '{print $2}' || true)"
if [ -z "$python_version" ]; then python_version="$(python --version 2>&1 | awk '{print $2}' || true)"; fi
mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
pnpm="false"; cmd pnpm && pnpm="true"
ffmpeg="false"; cmd ffmpeg && ffmpeg="true"
v4l2="false"; cmd v4l2-ctl && v4l2="true"
tailscale="false"; tailscale_connected="null"; tailscale_ip=""
if cmd tailscale; then
  tailscale="true"
  ts_status="$(tailscale status --json 2>/dev/null || true)"
  if printf '%s' "$ts_status" | grep -Eq '"Online"[[:space:]]*:[[:space:]]*true|"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then tailscale_connected="true"; else tailscale_connected="false"; fi
  tailscale_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
fi
all_ips="$(hostname -I 2>/dev/null || true)"
lan_ips=""
bridge_ips=""
other_ips=""
ipv6_ips=""
for ip in $all_ips; do
  case "$ip" in
    *:*) ipv6_ips="$ipv6_ips $ip" ;;
    "$tailscale_ip") ;;
    100.*) other_ips="$other_ips $ip" ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|10.42.*|192.168.122.*) bridge_ips="$bridge_ips $ip" ;;
    10.*|192.168.*|172.*) lan_ips="$lan_ips $ip" ;;
    *) other_ips="$other_ips $ip" ;;
  esac
done
disk="$(df -h "$HOME" 2>/dev/null | awk 'NR==2 {print $4 " free on " $6}' || true)"
video_devices="$(ls /dev/video* 2>/dev/null | tr '\n' ' ' || true)"
web_status="$(systemctl --user is-active plantlab-web.service 2>/dev/null || true)"
camera_status="$(systemctl --user is-active plantlab-camera.service 2>/dev/null || true)"
agent_status="$(systemctl --user is-active plantlab-agent.service 2>/dev/null || true)"
camera_json="[]"
if [ "$v4l2" = "true" ] && [ -n "$repo" ]; then
  # A dynamic import("./src/lib/v4l2.ts") inside a plain "node -e" eval does
  # not reliably resolve through tsx's loader (empirically: it silently
  # returns only a "default" export, so discoverLocalCameras is never
  # actually called and this always fell back to "[]") - a real file with a
  # static import, run inside the repo directory so the relative import
  # resolves correctly, does not have this problem.
  camera_probe_script="$repo/.plantlab-camera-probe-$$.mjs"
  cat > "$camera_probe_script" <<'CAMERA_PROBE_EOF'
import { discoverLocalCameras } from "./src/lib/v4l2.ts";
try {
  console.log(JSON.stringify(await discoverLocalCameras()));
} catch {
  console.log("[]");
}
CAMERA_PROBE_EOF
  camera_json="$(cd "$repo" && node --import tsx "$camera_probe_script" 2>/dev/null || printf '[]')"
  rm -f "$camera_probe_script"
fi
printf '{'
printf '"remoteHostname":"%s",' "$(json_escape "$(hostname 2>/dev/null || true)")"
printf '"remoteUser":"%s",' "$(json_escape "$(id -un 2>/dev/null || true)")"
printf '"operatingSystem":"%s",' "$(json_escape "$os_pretty")"
printf '"architecture":"%s",' "$(json_escape "$arch")"
printf '"repoPath":"%s",' "$(json_escape "$repo")"
printf '"plantLabVersion":"%s",' "$(json_escape "$version")"
printf '"gitBranch":"%s",' "$(json_escape "$branch")"
printf '"gitCommit":"%s",' "$(json_escape "$commit")"
printf '"role":"%s",' "$(json_escape "$role")"
printf '"coordinatorUrl":"%s",' "$(json_escape "$coordinator")"
printf '"nodeVersion":"%s",' "$(json_escape "$node_version")"
printf '"pythonVersion":"%s",' "$(json_escape "$python_version")"
printf '"memoryTotalKb":"%s",' "$(json_escape "$mem_total_kb")"
printf '"memoryAvailableKb":"%s",' "$(json_escape "$mem_avail_kb")"
printf '"pnpmAvailable":%s,' "$pnpm"
printf '"ffmpegAvailable":%s,' "$ffmpeg"
printf '"v4l2CtlAvailable":%s,' "$v4l2"
printf '"tailscaleInstalled":%s,' "$tailscale"
printf '"tailscaleConnected":%s,' "$tailscale_connected"
printf '"tailscaleIPv4":"%s",' "$(json_escape "$tailscale_ip")"
printf '"lanIPv4Addresses":[%s],' "$(printf '%s' "$lan_ips" | tr ' ' '\n' | awk 'NF {printf "%s\"%s\"", sep, $0; sep=","}')"
printf '"bridgeIPv4Addresses":[%s],' "$(printf '%s' "$bridge_ips" | tr ' ' '\n' | awk 'NF {printf "%s\"%s\"", sep, $0; sep=","}')"
printf '"otherIPv4Addresses":[%s],' "$(printf '%s' "$other_ips" | tr ' ' '\n' | awk 'NF {printf "%s\"%s\"", sep, $0; sep=","}')"
printf '"ipv6Addresses":[%s],' "$(printf '%s' "$ipv6_ips" | tr ' ' '\n' | awk 'NF {printf "%s\"%s\"", sep, $0; sep=","}')"
printf '"freeDiskSpace":"%s",' "$(json_escape "$disk")"
printf '"videoDevices":[%s],' "$(printf '%s' "$video_devices" | tr ' ' '\n' | awk 'NF {printf "%s\"%s\"", sep, $0; sep=","}')"
printf '"services":{"web":"%s","camera":"%s","agent":"%s"},' "$(json_escape "$web_status")" "$(json_escape "$camera_status")" "$(json_escape "$agent_status")"
printf '"cameras":%s' "$camera_json"
printf '}'
`;

export async function inspectRemoteHost(sshHost: string): Promise<RemoteInspection> {
  validateSshHost(sshHost);
  const resolvedHost = await resolveSshHost(sshHost);
  const result = await runLocalCommand("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost, "sh", "-s"], {
    input: INSPECT_SCRIPT,
    timeoutMs: REMOTE_HOST_INSPECTION_TIMEOUT_MS,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: message, status: 255 } as CommandResult;
  });

  if (result.status !== 0) {
    return {
      sshHost,
      resolvedHost,
      remoteHostname: null,
      remoteUser: null,
      operatingSystem: null,
      architecture: null,
      plantLabInstalled: false,
      plantLabVersion: null,
      repoPath: null,
      gitBranch: null,
      gitCommit: null,
      role: null,
      nodeVersion: null,
      pnpmAvailable: false,
      ffmpegAvailable: false,
      v4l2CtlAvailable: false,
      tailscaleInstalled: false,
      tailscaleConnected: null,
      tailscaleIPv4: null,
      lanIPv4Addresses: [],
      bridgeIPv4Addresses: [],
      otherIPv4Addresses: [],
      ipv6Addresses: [],
      freeDiskSpace: null,
      videoDevices: [],
      cameras: [],
      services: { web: null, camera: null, agent: null },
      coordinatorUrl: null,
      armVersion: null,
      memoryTotalMb: null,
      memoryAvailableMb: null,
      pythonVersion: null,
      fullAgentSupported: false,
      recommendedRuntime: "node",
      checks: [
        {
          name: "ssh",
          status: "fail",
          detail: result.stderr.trim() || `ssh exited with status ${result.status}`,
          suggestion: `Check that ${sshHost} is powered on and reachable with: ssh ${sshHost}`,
        },
      ],
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const repoPath = stringOrNull(parsed.repoPath);
  const role = stringOrNull(parsed.role);
  const architecture = stringOrNull(parsed.architecture);
  const armVersion = parseArmVersion(architecture);
  const memoryTotalMb = kbToMb(stringOrNull(parsed.memoryTotalKb));
  const memoryAvailableMb = kbToMb(stringOrNull(parsed.memoryAvailableKb));
  const feasibility = computeFullAgentSupport({ armVersion, memoryTotalMb });
  const checks: RemoteCheck[] = [
    { name: "ssh", status: "pass", detail: `Connected to ${sshHost}.` },
    repoPath
      ? { name: "plantlab-install", status: "pass", detail: `PlantLab found at ${repoPath}.` }
      : {
          name: "plantlab-install",
          status: "not-installed",
          detail: "No PlantLab repository was found in the standard locations.",
          suggestion: "Install or clone PlantLab on the remote machine before attaching it.",
        },
    role
      ? { name: "node-role", status: "pass", detail: `Configured as ${role}.` }
      : {
          name: "node-role",
          status: repoPath ? "warn" : "not-configured",
          detail: "No PlantLab node role is configured.",
          suggestion: `Run: plantlab node attach ${sshHost}`,
        },
    boolean(parsed.ffmpegAvailable)
      ? { name: "ffmpeg", status: "pass", detail: "ffmpeg is available." }
      : { name: "ffmpeg", status: "fail", detail: "ffmpeg is missing.", suggestion: "Install ffmpeg on the remote host." },
    boolean(parsed.v4l2CtlAvailable)
      ? { name: "v4l2-ctl", status: "pass", detail: "v4l2-ctl is available." }
      : { name: "v4l2-ctl", status: "warn", detail: "v4l2-ctl is missing, so camera inventory is limited." },
  ];

  return {
    sshHost,
    resolvedHost,
    remoteHostname: stringOrNull(parsed.remoteHostname),
    remoteUser: stringOrNull(parsed.remoteUser),
    operatingSystem: stringOrNull(parsed.operatingSystem),
    architecture,
    plantLabInstalled: Boolean(repoPath),
    plantLabVersion: stringOrNull(parsed.plantLabVersion),
    repoPath,
    gitBranch: stringOrNull(parsed.gitBranch),
    gitCommit: stringOrNull(parsed.gitCommit),
    role,
    nodeVersion: stringOrNull(parsed.nodeVersion),
    pnpmAvailable: boolean(parsed.pnpmAvailable),
    ffmpegAvailable: boolean(parsed.ffmpegAvailable),
    v4l2CtlAvailable: boolean(parsed.v4l2CtlAvailable),
    tailscaleInstalled: boolean(parsed.tailscaleInstalled),
    tailscaleConnected: typeof parsed.tailscaleConnected === "boolean" ? parsed.tailscaleConnected : null,
    tailscaleIPv4: stringOrNull(parsed.tailscaleIPv4),
    lanIPv4Addresses: stringArray(parsed.lanIPv4Addresses),
    bridgeIPv4Addresses: stringArray(parsed.bridgeIPv4Addresses),
    otherIPv4Addresses: stringArray(parsed.otherIPv4Addresses),
    ipv6Addresses: stringArray(parsed.ipv6Addresses),
    freeDiskSpace: stringOrNull(parsed.freeDiskSpace),
    videoDevices: stringArray(parsed.videoDevices),
    cameras: Array.isArray(parsed.cameras) ? (parsed.cameras as RemoteCameraInfo[]) : [],
    services: {
      web: stringOrNull((parsed.services as Record<string, unknown> | undefined)?.web),
      camera: stringOrNull((parsed.services as Record<string, unknown> | undefined)?.camera),
      agent: stringOrNull((parsed.services as Record<string, unknown> | undefined)?.agent),
    },
    coordinatorUrl: stringOrNull(parsed.coordinatorUrl),
    armVersion,
    memoryTotalMb,
    memoryAvailableMb,
    pythonVersion: stringOrNull(parsed.pythonVersion),
    fullAgentSupported: feasibility.fullAgentSupported,
    recommendedRuntime: feasibility.recommendedRuntime,
    checks,
    raw: parsed,
  };
}

export function defaultCoordinatorUrl(): string {
  return `http://${os.hostname()}:3000`;
}

export function expectedRemoteVersion() {
  return packageJson.version;
}

/** Step 2 of the attach sequence (see roleConvergence.ts) - checked BEFORE any writes, from the remote node's own network vantage point, since that's what actually matters for the agent's heartbeat later. */
export async function checkCoordinatorReachableFromRemote(
  sshHost: string,
  coordinatorUrl: string,
): Promise<{ reachable: boolean; detail: string }> {
  const script = `if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 '${coordinatorUrl.replace(/'/g, "'\\''")}/api/node-info' >/dev/null 2>&1 && echo REACHABLE || echo UNREACHABLE; else echo NOCURL; fi`;
  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: 10_000 });
  const output = result.stdout.trim();
  if (output === "REACHABLE") {
    return { reachable: true, detail: `${sshHost} can reach ${coordinatorUrl}.` };
  }
  if (output === "NOCURL") {
    return { reachable: true, detail: `curl is not installed on ${sshHost} - reachability could not be verified, proceeding anyway.` };
  }
  return { reachable: false, detail: `${sshHost} could not reach ${coordinatorUrl}/api/node-info.` };
}

export type RemoteAgentDiagnostics = {
  configExists: boolean;
  credentialExists: boolean;
  credentialMode: string | null;
  credentialDirMode: string | null;
  coordinatorUrl: string | null;
  spoolRoot: string | null;
  spoolWritable: boolean;
  agentScriptExists: boolean;
  nodePath: string | null;
  runBin: string | null;
  ffmpegAvailable: boolean;
  v4l2CtlAvailable: boolean;
  coordinatorReachable: boolean | null;
  agentStatus: string | null;
  agentJournal: string[];
};

export async function diagnoseRemoteAgent(sshHost: string, repoPath?: string | null): Promise<RemoteAgentDiagnostics> {
  const script = String.raw`
set -eu
repo="$1"
if [ -z "$repo" ]; then
  for p in "$HOME/projects/plantlab" "$HOME/plantlab" "$(pwd 2>/dev/null || printf '')"; do
    [ -n "$p" ] && [ -f "$p/package.json" ] && repo="$p" && break
  done
fi
home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"
if [ -z "$home_dir" ]; then home_dir="$HOME"; fi
env_dir="$home_dir/.config/plantlab"
env_path="$env_dir/agent.env"
config_path="$repo/plantlab.config.json"
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n'; }
config_exists=false; [ -f "$config_path" ] && config_exists=true
credential_exists=false; [ -f "$env_path" ] && credential_exists=true
credential_mode=""; [ -e "$env_path" ] && credential_mode="$(stat -c '%a' "$env_path" 2>/dev/null || true)"
credential_dir_mode=""; [ -d "$env_dir" ] && credential_dir_mode="$(stat -c '%a' "$env_dir" 2>/dev/null || true)"
coordinator_url=""
spool_root=""
if [ -f "$config_path" ]; then
  coordinator_url="$(node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c.coordinatorUrl||'')}catch{}" "$config_path" 2>/dev/null || true)"
  spool_root="$(node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c.spoolRoot||'')}catch{}" "$config_path" 2>/dev/null || true)"
fi
spool_writable=false
if [ -n "$spool_root" ]; then mkdir -p "$spool_root" 2>/dev/null && [ -w "$spool_root" ] && spool_writable=true; fi
agent_script_exists=false; [ -f "$repo/scripts/agent-service.ts" ] && agent_script_exists=true
node_path="$(command -v node 2>/dev/null || true)"
run_bin="$(command -v pnpm 2>/dev/null || command -v npm 2>/dev/null || true)"
ffmpeg=false; command -v ffmpeg >/dev/null 2>&1 && ffmpeg=true
v4l2=false; command -v v4l2-ctl >/dev/null 2>&1 && v4l2=true
coordinator_reachable=null
if [ -n "$coordinator_url" ]; then
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 3 "$coordinator_url/api/node-info" >/dev/null 2>&1; then coordinator_reachable=true; else coordinator_reachable=false; fi
fi
agent_status="$(systemctl --user is-active plantlab-agent.service 2>/dev/null || true)"
journal="$(journalctl --user -u plantlab-agent.service -n 20 --no-pager 2>/dev/null | tail -n 20 || true)"
printf '{'
printf '"configExists":%s,' "$config_exists"
printf '"credentialExists":%s,' "$credential_exists"
printf '"credentialMode":"%s",' "$(json_escape "$credential_mode")"
printf '"credentialDirMode":"%s",' "$(json_escape "$credential_dir_mode")"
printf '"coordinatorUrl":"%s",' "$(json_escape "$coordinator_url")"
printf '"spoolRoot":"%s",' "$(json_escape "$spool_root")"
printf '"spoolWritable":%s,' "$spool_writable"
printf '"agentScriptExists":%s,' "$agent_script_exists"
printf '"nodePath":"%s",' "$(json_escape "$node_path")"
printf '"runBin":"%s",' "$(json_escape "$run_bin")"
printf '"ffmpegAvailable":%s,' "$ffmpeg"
printf '"v4l2CtlAvailable":%s,' "$v4l2"
printf '"coordinatorReachable":%s,' "$coordinator_reachable"
printf '"agentStatus":"%s",' "$(json_escape "$agent_status")"
printf '"agentJournal":[%s]' "$(printf '%s\n' "$journal" | awk 'NF {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); printf "%s\"%s\"", sep, $0; sep=","}')"
printf '}\n'
`;
  const result = await runRemoteShell(sshHost, script, [repoPath ?? ""], { timeoutMs: 20_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Remote agent diagnostics failed.");
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  return {
    configExists: parsed.configExists === true,
    credentialExists: parsed.credentialExists === true,
    credentialMode: stringOrNull(parsed.credentialMode),
    credentialDirMode: stringOrNull(parsed.credentialDirMode),
    coordinatorUrl: stringOrNull(parsed.coordinatorUrl),
    spoolRoot: stringOrNull(parsed.spoolRoot),
    spoolWritable: parsed.spoolWritable === true,
    agentScriptExists: parsed.agentScriptExists === true,
    nodePath: stringOrNull(parsed.nodePath),
    runBin: stringOrNull(parsed.runBin),
    ffmpegAvailable: parsed.ffmpegAvailable === true,
    v4l2CtlAvailable: parsed.v4l2CtlAvailable === true,
    coordinatorReachable: typeof parsed.coordinatorReachable === "boolean" ? parsed.coordinatorReachable : null,
    agentStatus: stringOrNull(parsed.agentStatus),
    agentJournal: stringArray(parsed.agentJournal),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** Extracts the ARM ISA version from `uname -m` (e.g. "armv6l" -> "v6", "aarch64"/"armv8l" -> "v8"). Null for non-ARM architectures. */
function parseArmVersion(architecture: string | null): string | null {
  if (!architecture) return null;
  if (architecture === "aarch64" || architecture === "arm64") return "v8";
  const match = /^armv(\d+)/.exec(architecture);
  return match ? `v${match[1]}` : null;
}

function kbToMb(kb: string | null): number | null {
  if (!kb) return null;
  const parsed = Number(kb);
  return Number.isFinite(parsed) ? Math.round(parsed / 1024) : null;
}

/**
 * Pi Zero feasibility rule (Part 5): the full agent needs a JS engine
 * capable of running Next.js's toolchain comfortably and enough RAM to not
 * thrash - armv6 (the original Pi Zero/1/Zero W's ISA) never shipped a
 * modern V8/Node build people realistically run in production, and
 * anything under 768MB total memory makes a full Node.js + systemd stack a
 * poor fit regardless of ISA. Conservative on purpose: when in doubt,
 * recommend the lightweight edge agent - it works fine on capable hardware
 * too, just with less functionality than the full agent.
 */
export function computeFullAgentSupport(input: {
  armVersion: string | null;
  memoryTotalMb: number | null;
}): { fullAgentSupported: boolean; recommendedRuntime: "node" | "python-edge" } {
  const isArmv6OrOlder = input.armVersion !== null && Number(input.armVersion.replace(/^v/, "")) <= 6;
  const tooLittleMemory = input.memoryTotalMb !== null && input.memoryTotalMb < 768;
  const fullAgentSupported = !isArmv6OrOlder && !tooLittleMemory;
  return { fullAgentSupported, recommendedRuntime: fullAgentSupported ? "node" : "python-edge" };
}
