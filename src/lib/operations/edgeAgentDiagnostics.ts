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
  installDirExists: boolean;
  configExists: boolean;
  configPath: string | null;
  credentialPath: string | null;
  nodeName: string | null;
  role: string | null;
  coordinatorUrl: string | null;
  capabilities: string[];
  configValid: boolean;
  configError: string | null;
  credentialExists: boolean;
  credentialHasVariable: boolean;
  credentialMode: string | null;
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
  activeState: string | null;
  subState: string | null;
  mainPid: number | null;
  execMainStatus: number | null;
  restartCount: number | null;
  fragmentPath: string | null;
  dropInPaths: string | null;
  latestException: string | null;
  serviceShow: string[];
  serviceStatus: string[];
  journal: string[];
};

const SCRIPT = String.raw`
set -eu
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
edge_dir="$home_dir/plantlab-edge-agent"
install_dir="$home_dir/.local/share/plantlab-edge-agent"
config_path="$home_dir/.config/plantlab/edge-agent.json"
credential_path="$home_dir/.config/plantlab/agent.env"
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n'; }
json_array_lines() { awk 'NF {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); printf "%s\"%s\"", sep, $0; sep=","}'; }
edge_dir_exists=false; [ -d "$edge_dir" ] && edge_dir_exists=true
install_dir_exists=false; [ -d "$install_dir" ] && install_dir_exists=true
config_exists=false; [ -f "$config_path" ] && config_exists=true
credential_exists=false; [ -f "$credential_path" ] && credential_exists=true
credential_has_variable=false
[ -f "$credential_path" ] && grep -q '^PLANTLAB_NODE_CREDENTIAL=.' "$credential_path" 2>/dev/null && credential_has_variable=true
credential_mode=""; [ -e "$credential_path" ] && credential_mode="$(stat -c '%a' "$credential_path" 2>/dev/null || true)"
python_version="$(python3 --version 2>&1 | awk '{print $2}' || true)"
ffmpeg=false; command -v ffmpeg >/dev/null 2>&1 && ffmpeg=true
v4l2=false; command -v v4l2-ctl >/dev/null 2>&1 && v4l2=true
disk="$(df -h "$home_dir" 2>/dev/null | awk 'NR==2 {print $4 " free"}' || true)"
mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
spool_root=""
node_name=""
role=""
coordinator_url=""
capabilities=""
config_error=""
if [ -f "$config_path" ]; then
  config_json="$(python3 -c "import json,sys
try:
    c=json.load(open(sys.argv[1]))
    print(json.dumps({
      'nodeName': c.get('nodeName') or c.get('node_name') or '',
      'role': c.get('role') or '',
      'coordinatorUrl': c.get('coordinatorUrl') or c.get('coordinator_url') or '',
      'spoolRoot': c.get('spoolRoot') or c.get('spool_root') or '',
      'capabilities': c.get('capabilities') or []
    }))
except Exception as e:
    print(json.dumps({'error': str(e)}))" "$config_path" 2>/dev/null || true)"
  config_error="$(printf '%s' "$config_json" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('error',''))" 2>/dev/null || true)"
  node_name="$(printf '%s' "$config_json" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('nodeName',''))" 2>/dev/null || true)"
  role="$(printf '%s' "$config_json" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('role',''))" 2>/dev/null || true)"
  coordinator_url="$(printf '%s' "$config_json" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('coordinatorUrl',''))" 2>/dev/null || true)"
  spool_root="$(printf '%s' "$config_json" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('spoolRoot',''))" 2>/dev/null || true)"
  capabilities="$(printf '%s' "$config_json" | python3 -c "import json,sys; c=json.load(sys.stdin); print(','.join(c.get('capabilities') or []))" 2>/dev/null || true)"
fi
config_valid=false
[ -n "$node_name" ] && [ -n "$role" ] && [ -n "$coordinator_url" ] && [ -n "$spool_root" ] && [ -z "$config_error" ] && config_valid=true
spool_writable=false
spool_size_bytes=""
if [ -n "$spool_root" ]; then
  mkdir -p "$spool_root" 2>/dev/null || true
  [ -w "$spool_root" ] && spool_writable=true
  spool_size_bytes="$(du -sb "$spool_root" 2>/dev/null | awk '{print $1}' || true)"
fi
unit_status="$(systemctl --user is-active plantlab-edge-agent.service 2>/dev/null || true)"
show="$(systemctl --user show plantlab-edge-agent.service --property=Id,LoadState,ActiveState,SubState,Result,MainPID,ExecMainPID,ExecMainStatus,NRestarts,FragmentPath,DropInPaths,ExecStart 2>/dev/null || true)"
status_text="$(systemctl --user status plantlab-edge-agent.service --no-pager -l 2>/dev/null | tail -n 40 || true)"
journal_text="$(journalctl --user -u plantlab-edge-agent.service -n 80 --no-pager 2>/dev/null | tail -n 80 || true)"
latest_exception="$(printf '%s\n%s\n' "$status_text" "$journal_text" | grep -Ei 'Traceback|Exception|Fatal PlantLab|ProtocolError|returned [0-9]{3}|No module|coordinatorUrl|PLANTLAB_NODE_CREDENTIAL|failed|error' | tail -n 1 || true)"
active_state="$(printf '%s\n' "$show" | sed -n 's/^ActiveState=//p' | head -n1)"
sub_state="$(printf '%s\n' "$show" | sed -n 's/^SubState=//p' | head -n1)"
main_pid="$(printf '%s\n' "$show" | sed -n 's/^MainPID=//p' | head -n1)"
exec_main_status="$(printf '%s\n' "$show" | sed -n 's/^ExecMainStatus=//p' | head -n1)"
restart_count="$(printf '%s\n' "$show" | sed -n 's/^NRestarts=//p' | head -n1)"
fragment_path="$(printf '%s\n' "$show" | sed -n 's/^FragmentPath=//p' | head -n1)"
dropin_paths="$(printf '%s\n' "$show" | sed -n 's/^DropInPaths=//p' | head -n1)"
printf '{'
printf '"edgeAgentDirExists":%s,' "$edge_dir_exists"
printf '"installDirExists":%s,' "$install_dir_exists"
printf '"configExists":%s,' "$config_exists"
printf '"configPath":"%s",' "$(json_escape "$config_path")"
printf '"credentialPath":"%s",' "$(json_escape "$credential_path")"
printf '"nodeName":"%s",' "$(json_escape "$node_name")"
printf '"role":"%s",' "$(json_escape "$role")"
printf '"coordinatorUrl":"%s",' "$(json_escape "$coordinator_url")"
printf '"capabilities":[%s],' "$(printf '%s' "$capabilities" | tr ',' '\n' | awk 'NF {printf "%s\"%s\"", sep, $0; sep=","}')"
printf '"configValid":%s,' "$config_valid"
printf '"configError":"%s",' "$(json_escape "$config_error")"
printf '"credentialExists":%s,' "$credential_exists"
printf '"credentialHasVariable":%s,' "$credential_has_variable"
printf '"credentialMode":"%s",' "$(json_escape "$credential_mode")"
printf '"pythonVersion":"%s",' "$(json_escape "$python_version")"
printf '"ffmpegAvailable":%s,' "$ffmpeg"
printf '"v4l2CtlAvailable":%s,' "$v4l2"
printf '"diskFree":"%s",' "$(json_escape "$disk")"
printf '"memoryTotalKb":"%s",' "$(json_escape "$mem_total_kb")"
printf '"memoryAvailableKb":"%s",' "$(json_escape "$mem_avail_kb")"
printf '"spoolRoot":"%s",' "$(json_escape "$spool_root")"
printf '"spoolWritable":%s,' "$spool_writable"
printf '"spoolSizeBytes":"%s",' "$(json_escape "$spool_size_bytes")"
printf '"unitStatus":"%s",' "$(json_escape "$unit_status")"
printf '"activeState":"%s",' "$(json_escape "$active_state")"
printf '"subState":"%s",' "$(json_escape "$sub_state")"
printf '"mainPid":"%s",' "$(json_escape "$main_pid")"
printf '"execMainStatus":"%s",' "$(json_escape "$exec_main_status")"
printf '"restartCount":"%s",' "$(json_escape "$restart_count")"
printf '"fragmentPath":"%s",' "$(json_escape "$fragment_path")"
printf '"dropInPaths":"%s",' "$(json_escape "$dropin_paths")"
printf '"latestException":"%s",' "$(json_escape "$latest_exception")"
printf '"serviceShow":[%s],' "$(printf '%s\n' "$show" | json_array_lines)"
printf '"serviceStatus":[%s],' "$(printf '%s\n' "$status_text" | json_array_lines)"
printf '"journal":[%s]' "$(printf '%s\n' "$journal_text" | json_array_lines)"
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
    installDirExists: parsed.installDirExists === true,
    configExists: parsed.configExists === true,
    configPath: str(parsed.configPath),
    credentialPath: str(parsed.credentialPath),
    nodeName: str(parsed.nodeName),
    role: str(parsed.role),
    coordinatorUrl: str(parsed.coordinatorUrl),
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((item): item is string => typeof item === "string") : [],
    configValid: parsed.configValid === true,
    configError: str(parsed.configError),
    credentialExists: parsed.credentialExists === true,
    credentialHasVariable: parsed.credentialHasVariable === true,
    credentialMode: str(parsed.credentialMode),
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
    activeState: str(parsed.activeState),
    subState: str(parsed.subState),
    mainPid: str(parsed.mainPid) ? Number(parsed.mainPid) : null,
    execMainStatus: str(parsed.execMainStatus) ? Number(parsed.execMainStatus) : null,
    restartCount: str(parsed.restartCount) ? Number(parsed.restartCount) : null,
    fragmentPath: str(parsed.fragmentPath),
    dropInPaths: str(parsed.dropInPaths),
    latestException: str(parsed.latestException),
    serviceShow: Array.isArray(parsed.serviceShow) ? parsed.serviceShow.filter((item): item is string => typeof item === "string") : [],
    serviceStatus: Array.isArray(parsed.serviceStatus) ? parsed.serviceStatus.filter((item): item is string => typeof item === "string") : [],
    journal: Array.isArray(parsed.journal) ? parsed.journal.filter((item): item is string => typeof item === "string") : [],
  };
}
