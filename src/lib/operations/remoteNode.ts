import { execFile, spawn } from "node:child_process";
import os from "node:os";
import packageJson from "../../../package.json";
import type { NodeRole } from "./config";
import { SERVICE_UNITS, type PlantLabServiceName } from "./serviceRoles";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/remoteNode.ts shells out to ssh and must not run in a browser.");
}

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
  raw?: unknown;
};

const HOST_PATTERN = /^[A-Za-z0-9._@:+-]+$/;

export function validateSshHost(host: string): void {
  if (!HOST_PATTERN.test(host) || host.startsWith("-")) {
    throw new Error(`Unsafe SSH host "${host}". Use an alias from ~/.ssh/config without whitespace or shell metacharacters.`);
  }
}

export type CommandResult = { stdout: string; stderr: string; status: number | null };

function runLocal(command: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 15000}ms.`));
    }, options.timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function runRemoteShell(
  sshHost: string,
  script: string,
  args: string[] = [],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  validateSshHost(sshHost);
  return runLocal("ssh", [sshHost, "sh", "-s", "--", ...args], {
    input: `${script}\n${options.input ?? ""}`,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
}

export async function resolveSshHost(host: string): Promise<string | null> {
  validateSshHost(host);
  return new Promise((resolve) => {
    execFile("ssh", ["-G", host], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const hostName = stdout
        .toString()
        .split("\n")
        .find((line) => line.toLowerCase().startsWith("hostname "))
        ?.split(/\s+/)
        .slice(1)
        .join(" ");
      resolve(hostName || null);
    });
  });
}

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
  camera_json="$(cd "$repo" && node --import tsx -e "import('./src/lib/v4l2.ts').then(async m => console.log(JSON.stringify(await m.discoverLocalCameras()))).catch(() => console.log('[]'))" 2>/dev/null || printf '[]')"
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
  const result = await runLocal("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost, "sh", "-s"], {
    input: INSPECT_SCRIPT,
    timeoutMs: 20_000,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: message, status: 255 };
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
    architecture: stringOrNull(parsed.architecture),
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
    checks,
    raw: parsed,
  };
}

export function buildAgentServiceUnit(input: { repoPath: string; runBin: string; envPath: string }) {
  return `[Unit]
Description=PlantLab camera-node agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.repoPath}
Environment=NODE_ENV=production
Environment=PLANTLAB_ROOT_DIR=${input.repoPath}
EnvironmentFile=${input.envPath}
ExecStart=${input.runBin} run agent:service
SyslogIdentifier=plantlab-agent
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function buildConfigureRemoteAgentScript(): string {
  return String.raw`
set -eu
repo="$1"
home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"
if [ -z "$home_dir" ]; then home_dir="$HOME"; fi
env_dir="$home_dir/.config/plantlab"
unit_dir="$home_dir/.config/systemd/user"
env_path="$env_dir/agent.env"
unit_path="$unit_dir/plantlab-agent.service"
spool="$2"
has_credential="$4"
mkdir -p "$repo" "$env_dir" "$unit_dir" "$spool"
chmod 700 "$env_dir"
umask 077
tmp="$(mktemp)"
config_tmp="$(mktemp "$repo/plantlab.config.json.tmp.XXXXXX")"
env_tmp="$(mktemp "$env_dir/agent.env.tmp.XXXXXX")"
unit_tmp="$(mktemp "$unit_dir/plantlab-agent.service.tmp.XXXXXX")"
trap 'rm -f "$tmp" "$config_tmp" "$env_tmp" "$unit_tmp"' EXIT
cat > "$tmp"
awk '
  /^__PLANTLAB_CONFIG__$/ { section="config"; next }
  /^__PLANTLAB_ENV__$/ { section="env"; next }
  /^__PLANTLAB_UNIT__$/ { section="unit"; next }
  /^__PLANTLAB_END__$/ { section=""; next }
  section=="config" { print > config_path; next }
  section=="env" { print > env_path; next }
  section=="unit" { print > unit_path; next }
' config_path="$config_tmp" env_path="$env_tmp" unit_path="$unit_tmp" "$tmp"
run_bin="$(command -v pnpm || command -v npm || true)"
if [ -z "$run_bin" ]; then
  echo "Neither pnpm nor npm found on remote PATH." >&2
  exit 12
fi
mv "$config_tmp" "$repo/plantlab.config.json"
if [ "$has_credential" = "1" ]; then
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$env_path"
else
  rm -f "$env_tmp"
fi
sed "s#__REPO_PATH__#$repo#g; s#__RUN_BIN__#$run_bin#g; s#__ENV_PATH__#$env_path#g" "$unit_tmp" > "$unit_path"
if [ ! -f "$env_path" ]; then
  echo "Agent credential file was not created at $env_path" >&2
  exit 20
fi
chmod 600 "$env_path"
env_mode="$(stat -c '%a' "$env_path")"
env_owner="$(stat -c '%U' "$env_path")"
dir_mode="$(stat -c '%a' "$env_dir")"
if [ "$env_mode" != "600" ]; then echo "Credential file mode is $env_mode, expected 600" >&2; exit 21; fi
if [ "$dir_mode" != "700" ]; then echo "Credential directory mode is $dir_mode, expected 700" >&2; exit 22; fi
systemctl --user daemon-reload
if [ "$3" = "1" ]; then
  systemctl --user disable --now plantlab-web.service plantlab-camera.service >/dev/null 2>&1 || true
  systemctl --user enable --now plantlab-agent.service
fi
printf '{"envPath":"%s","envMode":"%s","envOwner":"%s","envDirMode":"%s","unitPath":"%s"}\n' "$env_path" "$env_mode" "$env_owner" "$dir_mode" "$unit_path"
`;
}

export async function configureRemoteAgent(input: {
  sshHost: string;
  repoPath: string;
  nodeName: string;
  coordinatorUrl: string;
  credential: string | null;
  spoolRoot: string;
  startService: boolean;
}) {
  validateSshHost(input.sshHost);
  const config = {
    formatVersion: 1,
    role: "camera-node" satisfies NodeRole,
    configuredAt: new Date().toISOString(),
    hostname: input.nodeName,
    coordinatorUrl: input.coordinatorUrl,
    nodeName: input.nodeName,
    spoolRoot: input.spoolRoot,
  };
  const env = input.credential ? `PLANTLAB_NODE_CREDENTIAL=${input.credential}\n` : "";
  const remoteScript = buildConfigureRemoteAgentScript();
  const unitTemplate = buildAgentServiceUnit({ repoPath: "__REPO_PATH__", runBin: "__RUN_BIN__", envPath: "__ENV_PATH__" });
  const payload = [
    "__PLANTLAB_CONFIG__",
    JSON.stringify(config, null, 2),
    "__PLANTLAB_ENV__",
    env.trimEnd(),
    "__PLANTLAB_UNIT__",
    unitTemplate.trimEnd(),
    "__PLANTLAB_END__",
    "",
  ].join("\n");
  return runLocal("ssh", [input.sshHost, "sh", "-s", "--", input.repoPath, input.spoolRoot, input.startService ? "1" : "0", input.credential ? "1" : "0"], {
    input: `${remoteScript}\n${payload}`,
    timeoutMs: 20_000,
  });
}

export function defaultCoordinatorUrl(): string {
  return `http://${os.hostname()}:3000`;
}

export function expectedRemoteVersion() {
  return packageJson.version;
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

export async function applyRemoteServiceRole(sshHost: string, role: NodeRole | string): Promise<CommandResult> {
  const expected: PlantLabServiceName[] = role === "camera-node" ? ["agent"] : role === "coordinator" ? ["web"] : ["web", "camera"];
  const stop = (Object.keys(SERVICE_UNITS) as PlantLabServiceName[]).filter((service) => !expected.includes(service));
  const startUnits = expected.map((service) => SERVICE_UNITS[service]);
  const stopUnits = stop.map((service) => SERVICE_UNITS[service]);
  const script = [
    "set -eu",
    stopUnits.length > 0 ? `systemctl --user disable --now ${stopUnits.map((unit) => `'${unit}'`).join(" ")} >/dev/null 2>&1 || true` : ":",
    startUnits.length > 0 ? `systemctl --user enable --now ${startUnits.map((unit) => `'${unit}'`).join(" ")}` : ":",
  ].join("\n");
  return runRemoteShell(sshHost, script, [], { timeoutMs: 20_000 });
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
