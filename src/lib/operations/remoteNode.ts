import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import packageJson from "../../../package.json";
import type { NodeRole } from "./config";

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

function runLocal(command: string, args: string[], options: { input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
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
  if printf '%s' "$ts_status" | grep -q '"Online":true'; then tailscale_connected="true"; else tailscale_connected="false"; fi
  tailscale_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
fi
lan_ips="$(hostname -I 2>/dev/null || true)"
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

export async function configureRemoteAgent(input: {
  sshHost: string;
  repoPath: string;
  nodeName: string;
  coordinatorUrl: string;
  credential: string;
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
  const env = `PLANTLAB_NODE_CREDENTIAL=${input.credential}\n`;
  const remoteScript = String.raw`
set -eu
repo="$1"
env_path="\${HOME}/.config/plantlab/agent.env"
unit_path="\${HOME}/.config/systemd/user/plantlab-agent.service"
spool="$2"
mkdir -p "$repo" "\${HOME}/.config/plantlab" "\${HOME}/.config/systemd/user" "$spool"
umask 077
tmp="$(mktemp)"
unit_tmp="$(mktemp)"
trap 'rm -f "$tmp" "$unit_tmp"' EXIT
cat > "$tmp"
awk '
  /^__PLANTLAB_CONFIG__$/ { section="config"; next }
  /^__PLANTLAB_ENV__$/ { section="env"; next }
  /^__PLANTLAB_UNIT__$/ { section="unit"; next }
  /^__PLANTLAB_END__$/ { section=""; next }
  section=="config" { print > config_path; next }
  section=="env" { print > env_path; next }
  section=="unit" { print > unit_path; next }
' config_path="$repo/plantlab.config.json" env_path="$env_path" unit_path="$unit_tmp" "$tmp"
run_bin="$(command -v pnpm || command -v npm || true)"
if [ -z "$run_bin" ]; then
  echo "Neither pnpm nor npm found on remote PATH." >&2
  exit 12
fi
sed "s#__REPO_PATH__#$repo#g; s#__RUN_BIN__#$run_bin#g; s#__ENV_PATH__#$env_path#g" "$unit_tmp" > "$unit_path"
chmod 600 "$env_path"
systemctl --user daemon-reload
if [ "$3" = "1" ]; then
  systemctl --user enable --now plantlab-agent.service
fi
printf '{"envPath":"%s","unitPath":"%s"}\n' "$env_path" "$unit_path"
`;
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
  return runLocal("ssh", [input.sshHost, "sh", "-s", "--", input.repoPath, input.spoolRoot, input.startService ? "1" : "0"], {
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
