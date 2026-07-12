// Remote diagnostics for a Python edge-agent node (Part 13) - the
// lightweight-runtime counterpart of diagnoseRemoteAgent() in
// remoteNode.ts. Read-only, like that function; the actual repair path is
// credentialRepair.ts's rotateAndInstallCredential() with
// runtime: "python-edge".

import { runRemoteShell, validateSshHost, type CommandResult } from "./shellExec";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/edgeAgentDiagnostics.ts shells out to ssh and must not run in a browser.");
}

export type EdgeAgentDiagnostics = {
  edgeAgentDirExists: boolean;
  configExists: boolean;
  pythonVersion: string | null;
  ffmpegAvailable: boolean;
  v4l2CtlAvailable: boolean;
  diskFree: string | null;
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
  spoolRoot: string | null;
  spoolWritable: boolean;
  spoolSizeBytes: number | null;
  unitStatus: string | null;
};

const SCRIPT = String.raw`
set -eu
home_dir="$HOME"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
edge_dir="$home_dir/plantlab-edge-agent"
config_path="$home_dir/.config/plantlab/edge-agent.json"
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n'; }
edge_dir_exists=false; [ -d "$edge_dir" ] && edge_dir_exists=true
config_exists=false; [ -f "$config_path" ] && config_exists=true
python_version="$(python3 --version 2>&1 | awk '{print $2}' || true)"
ffmpeg=false; command -v ffmpeg >/dev/null 2>&1 && ffmpeg=true
v4l2=false; command -v v4l2-ctl >/dev/null 2>&1 && v4l2=true
disk="$(df -h "$home_dir" 2>/dev/null | awk 'NR==2 {print $4 " free"}' || true)"
mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
spool_root=""
if [ -f "$config_path" ]; then
  spool_root="$(python3 -c "import json,sys
try:
    print(json.load(open(sys.argv[1])).get('spoolRoot') or '')
except Exception:
    print('')" "$config_path" 2>/dev/null || true)"
fi
spool_writable=false
spool_size_bytes=""
if [ -n "$spool_root" ]; then
  mkdir -p "$spool_root" 2>/dev/null || true
  [ -w "$spool_root" ] && spool_writable=true
  spool_size_bytes="$(du -sb "$spool_root" 2>/dev/null | awk '{print $1}' || true)"
fi
unit_status="$(systemctl --user is-active plantlab-edge-agent.service 2>/dev/null || true)"
printf '{'
printf '"edgeAgentDirExists":%s,' "$edge_dir_exists"
printf '"configExists":%s,' "$config_exists"
printf '"pythonVersion":"%s",' "$(json_escape "$python_version")"
printf '"ffmpegAvailable":%s,' "$ffmpeg"
printf '"v4l2CtlAvailable":%s,' "$v4l2"
printf '"diskFree":"%s",' "$(json_escape "$disk")"
printf '"memoryTotalKb":"%s",' "$(json_escape "$mem_total_kb")"
printf '"memoryAvailableKb":"%s",' "$(json_escape "$mem_avail_kb")"
printf '"spoolRoot":"%s",' "$(json_escape "$spool_root")"
printf '"spoolWritable":%s,' "$spool_writable"
printf '"spoolSizeBytes":"%s",' "$(json_escape "$spool_size_bytes")"
printf '"unitStatus":"%s"' "$(json_escape "$unit_status")"
printf '}\n'
`;

export async function diagnoseEdgeAgent(sshHost: string): Promise<EdgeAgentDiagnostics> {
  validateSshHost(sshHost);
  const result: CommandResult = await runRemoteShell(sshHost, SCRIPT, [], { timeoutMs: 20_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Remote edge-agent diagnostics failed.");
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const kbToMb = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && String(v).trim() ? Math.round(n / 1024) : null;
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    edgeAgentDirExists: parsed.edgeAgentDirExists === true,
    configExists: parsed.configExists === true,
    pythonVersion: str(parsed.pythonVersion),
    ffmpegAvailable: parsed.ffmpegAvailable === true,
    v4l2CtlAvailable: parsed.v4l2CtlAvailable === true,
    diskFree: str(parsed.diskFree),
    memoryTotalMb: kbToMb(parsed.memoryTotalKb),
    memoryAvailableMb: kbToMb(parsed.memoryAvailableKb),
    spoolRoot: str(parsed.spoolRoot),
    spoolWritable: parsed.spoolWritable === true,
    spoolSizeBytes: str(parsed.spoolSizeBytes) ? Number(parsed.spoolSizeBytes) : null,
    unitStatus: str(parsed.unitStatus),
  };
}
