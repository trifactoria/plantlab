// Automatic credential recovery for camera-node/greenhouse-node agents
// (Parts 1-4 of the credential-recovery task). The real bokchoy failure:
// `node attach` saw a credential file that existed with correct
// permissions (0600/0700) and concluded "existing credential retained" -
// but the file's actual *content* didn't authenticate, so the agent threw
// "PLANTLAB_NODE_CREDENTIAL is not set" on startup. File
// existence/permissions are necessary but not sufficient evidence a
// credential is usable; only a live authenticated round trip against the
// coordinator proves that. See DEPLOYMENT.md "Automatic credential
// recovery".
//
// The credential's raw value never leaves the remote node during a probe:
// the remote shell script tests it directly against the coordinator via
// curl and prints only a status keyword - never the credential itself -
// back over the SSH channel. See probeRemoteCredential().
//
// Both agent runtimes (the full TypeScript agent and the lightweight
// Python edge agent - see edge-agent/) read their credential from the same
// path and format (`~/.config/plantlab/agent.env`,
// `PLANTLAB_NODE_CREDENTIAL=...`), so probeRemoteCredential() and the
// credential-file-write step work unchanged for either. Only the
// "how do I get this runtime's agent to pick up the new file" step differs
// (systemd unit convergence for "node", a narrower restart for
// "python-edge") - see installCredentialForRuntime().

import { runRemoteShell } from "./shellExec";
import { shellQuote } from "./systemdUnits";
import { convergeNodeRole, type ConvergenceStep } from "./roleConvergence";
import { convergeEdgeAgentConfig } from "./edgeAgentInstall";
import { registerOrRotateNode, markNodeStatus, type RegisterNodeInput } from "./nodeCredentials";
import type { PrismaClient } from "@prisma/client";
import type { NodeRole } from "./config";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/credentialRepair.ts shells out to ssh and must not run in a browser.");
}

export const CREDENTIAL_PROBE_STATUSES = ["missing", "empty", "var-missing", "malformed", "rejected", "valid", "unknown"] as const;
export type CredentialProbeStatus = (typeof CREDENTIAL_PROBE_STATUSES)[number];

/**
 * The specific network-layer reason a probe couldn't be completed, when
 * status is "unknown" for a network reason (never for the file-based
 * statuses) - Part 4's "Doctor should distinguish: DNS resolution failure,
 * TCP connection failure, coordinator endpoint mismatch ... service
 * crash". Kept separate from `status` deliberately: `status` drives the
 * rotate/don't-rotate decision (see INVALID_STATUSES below - a network
 * problem must never look like an invalid credential and trigger
 * rotation), `networkIssue` is purely for diagnostic display.
 */
export const NETWORK_ISSUES = ["dns", "tcp", "timeout", "endpoint-mismatch", "service-error"] as const;
export type NetworkIssue = (typeof NETWORK_ISSUES)[number];

export type CredentialProbeResult = {
  status: CredentialProbeStatus;
  detail: string;
  networkIssue?: NetworkIssue;
};

/**
 * Tests the remote node's actual on-disk credential against the
 * coordinator's `/api/agents/credential-check` endpoint, entirely within
 * the remote shell process - the credential value is read, validated, and
 * used for one curl call on the remote machine, and is never printed to
 * stdout/stderr or returned to this process. Only one of
 * CREDENTIAL_PROBE_STATUSES comes back.
 *
 * Classifies the *network* outcome (DNS/TCP/timeout/wrong endpoint/
 * coordinator error) separately from an actual credential rejection
 * (HTTP 401) - the real greenhouse-zero bug: a coordinator URL that fails
 * DNS resolution was previously indistinguishable from a genuinely revoked
 * credential, so attach kept rotating credentials that were never the
 * problem while waiting for a heartbeat that could never arrive.
 *
 * Deliberately `set -u` only (never `set -e`) in the remote script - under
 * `set -e`, a failing command inside `var="$(cmd)"` aborts the whole
 * script in dash (Raspberry Pi OS Lite's /bin/sh) before the next line can
 * inspect `$?`, verified empirically against a real Pi. See
 * coordinatorDiscovery.ts's identical fix for the full writeup.
 */
export async function probeRemoteCredential(input: {
  sshHost: string;
  coordinatorUrl: string;
  remoteUser?: string | null;
}): Promise<CredentialProbeResult> {
  const script = String.raw`
set -u
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
env_path="$home_dir/.config/plantlab/agent.env"
coordinator_url=${shellQuote(input.coordinatorUrl)}

if [ ! -f "$env_path" ]; then echo "MISSING"; exit 0; fi
if [ ! -s "$env_path" ]; then echo "EMPTY"; exit 0; fi

value="$(sed -n 's/^PLANTLAB_NODE_CREDENTIAL=//p' "$env_path" | head -n1)"
if [ -z "$value" ]; then echo "VAR_MISSING"; exit 0; fi

case "$value" in
  pln_*) : ;;
  *) echo "MALFORMED"; exit 0 ;;
esac

if ! command -v curl >/dev/null 2>&1; then echo "NOCURL"; exit 0; fi

err_file="$(mktemp)"
curl_status=0
http_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST -H "authorization: Bearer $value" -H "content-type: application/json" "$coordinator_url/api/agents/credential-check" 2>"$err_file")" || curl_status=$?
rm -f "$err_file"

if [ "$http_code" = "200" ]; then
  echo "VALID"
elif [ "$http_code" = "401" ]; then
  echo "REJECTED"
elif [ -n "$http_code" ] && [ "$http_code" != "000" ]; then
  echo "ENDPOINT_MISMATCH:$http_code"
else
  case "$curl_status" in
    6) echo "DNS_FAILURE" ;;
    7) echo "TCP_FAILURE" ;;
    28) echo "TIMEOUT" ;;
    *) echo "NETWORK_UNKNOWN:$curl_status" ;;
  esac
fi
`;

  const result = await runRemoteShell(input.sshHost, script, [], { timeoutMs: 20_000 }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    status: 255,
  }));

  const line = result.stdout.trim().split("\n").pop()?.trim() ?? "";
  switch (true) {
    case line === "MISSING":
      return { status: "missing", detail: "Credential file is missing on the remote node." };
    case line === "EMPTY":
      return { status: "empty", detail: "Credential file exists but is empty." };
    case line === "VAR_MISSING":
      return { status: "var-missing", detail: "Credential file exists but does not set PLANTLAB_NODE_CREDENTIAL." };
    case line === "MALFORMED":
      return { status: "malformed", detail: "Credential file's value does not look like a valid PlantLab node credential." };
    case line === "VALID":
      return { status: "valid", detail: "Credential authenticated successfully against the coordinator." };
    case line === "REJECTED":
      return { status: "rejected", detail: "Credential was rejected by the coordinator (revoked, rotated, or never matched)." };
    case line === "NOCURL":
      return { status: "unknown", detail: "curl is not installed on the remote node - credential validity could not be verified." };
    case line === "DNS_FAILURE":
      return {
        status: "unknown",
        detail: `Could not resolve the coordinator hostname in "${input.coordinatorUrl}" - this is a DNS/networking problem, not an invalid credential.`,
        networkIssue: "dns",
      };
    case line === "TCP_FAILURE":
      return {
        status: "unknown",
        detail: `Could not connect to "${input.coordinatorUrl}" (connection refused) - this is a networking problem, not an invalid credential.`,
        networkIssue: "tcp",
      };
    case line === "TIMEOUT":
      return {
        status: "unknown",
        detail: `Connection to "${input.coordinatorUrl}" timed out - this is a networking problem, not an invalid credential.`,
        networkIssue: "timeout",
      };
    case line.startsWith("ENDPOINT_MISMATCH:"): {
      const httpCode = line.split(":")[1] ?? "";
      const isServerError = httpCode.startsWith("5");
      return {
        status: "unknown",
        detail: isServerError
          ? `"${input.coordinatorUrl}" responded with HTTP ${httpCode} - the coordinator app may have crashed or be unhealthy.`
          : `"${input.coordinatorUrl}" responded with HTTP ${httpCode}, not a PlantLab coordinator - check the URL/port point at the right app.`,
        networkIssue: isServerError ? "service-error" : "endpoint-mismatch",
      };
    }
    default:
      return {
        status: "unknown",
        detail: result.stderr.trim() || `Could not determine credential status (exit ${result.status}).`,
      };
  }
}

/** Statuses that mean "the credential is demonstrably not usable" and should trigger automatic rotation. "unknown" deliberately does not - see probeRemoteCredential()'s NOCURL case; we never force a rotation on inconclusive evidence. */
const INVALID_STATUSES = new Set<CredentialProbeStatus>(["missing", "empty", "var-missing", "malformed", "rejected"]);

export async function waitForNodeHeartbeat(prisma: PrismaClient, nodeId: string, since: Date, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const node = await prisma.plantLabNode.findUnique({ where: { id: nodeId }, select: { lastHeartbeatAt: true } });
    if (node?.lastHeartbeatAt && node.lastHeartbeatAt >= since) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

export type NodeRuntime = "node" | "python-edge";

/**
 * Writes a rotated credential and gets the *edge* agent to pick it up.
 * Deliberately independent of convergeNodeRole()/systemdUnits.ts (which
 * builds Node.js-specific unit files) - the edge agent's systemd unit is
 * installed once by edge-agent/install.sh and never re-templated here,
 * only its credential file and a restart. Same mktemp+mv+chmod+verify
 * pattern as the TS-agent path (see systemdUnits.ts buildUnitConvergenceScript)
 * for the same reason: never write through a stale mask symlink.
 */
async function installEdgeAgentCredential(input: {
  sshHost: string;
  credential: string | null;
  /** Restart plantlab-edge-agent.service even when no new credential is being written - e.g. doctor's "Restart edge agent?" repair item, independent of whether rotation was needed. */
  forceRestart?: boolean;
}): Promise<{ ok: boolean; steps: ConvergenceStep[] }> {
  if (!input.credential) {
    if (!input.forceRestart) {
      return { ok: true, steps: [{ name: "credential-write", status: "skipped", detail: "No new credential to install." }] };
    }
    const restartOnlyScript = "systemctl --user daemon-reload >/dev/null 2>&1 || true\nsystemctl --user restart plantlab-edge-agent.service\n";
    const restartResult = await runRemoteShell(input.sshHost, restartOnlyScript, [], { timeoutMs: 20_000 });
    if (restartResult.status !== 0) {
      return {
        ok: false,
        steps: [
          { name: "credential-write", status: "skipped", detail: "No new credential to install." },
          { name: "agent-restart", status: "failed", detail: (restartResult.stderr.trim() || "Restart failed.").slice(0, 2000) },
        ],
      };
    }
    return {
      ok: true,
      steps: [
        { name: "credential-write", status: "skipped", detail: "No new credential to install." },
        { name: "agent-restart", status: "completed", detail: "plantlab-edge-agent.service restarted." },
      ],
    };
  }

  const script = String.raw`
set -eu
home_dir="${"${HOME:-}"}"
if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi
env_dir="$home_dir/.config/plantlab"
env_path="$env_dir/agent.env"
mkdir -p "$env_dir"
chmod 700 "$env_dir"
umask 077
env_tmp="$(mktemp "$env_dir/agent.env.tmp.XXXXXX")"
cat > "$env_tmp" <<'PLANTLAB_ENV_EOF'
PLANTLAB_NODE_CREDENTIAL=${input.credential}
PLANTLAB_ENV_EOF
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_path"
env_mode="$(stat -c '%a' "$env_path")"
if [ "$env_mode" != "600" ]; then echo "Credential file mode is $env_mode, expected 600" >&2; exit 21; fi
dir_mode="$(stat -c '%a' "$env_dir")"
if [ "$dir_mode" != "700" ]; then echo "Credential directory mode is $dir_mode, expected 700" >&2; exit 22; fi
systemctl --user daemon-reload >/dev/null 2>&1 || true
systemctl --user restart plantlab-edge-agent.service
`;

  const result = await runRemoteShell(input.sshHost, script, [], { timeoutMs: 20_000 });
  if (result.status !== 0) {
    return {
      ok: false,
      steps: [{ name: "credential-write", status: "failed", detail: (result.stderr.trim() || result.stdout.trim() || "Edge agent credential install failed.").slice(0, 2000) }],
    };
  }
  return {
    ok: true,
    steps: [
      { name: "credential-write", status: "completed", detail: "Credential written to the edge agent's env file (0600)." },
      { name: "agent-restart", status: "completed", detail: "plantlab-edge-agent.service restarted." },
    ],
  };
}

export type CredentialInstallInput = {
  sshHost: string;
  repoPath: string;
  coordinatorUrl: string;
  role: NodeRole;
  runtime: NodeRuntime;
  nodeName?: string | null;
  spoolRoot?: string | null;
  remoteUser?: string | null;
  registerInput: Omit<RegisterNodeInput, "rotateCredential">;
  heartbeatTimeoutMs?: number;
  /** Defaults to true. When false, skips the heartbeat wait entirely (and never marks the node repair-required for lack of one) - the caller explicitly declined to wait, which is not the same as a failed wait. */
  waitForHeartbeat?: boolean;
  /** Restart the agent even when `rotate` is false (e.g. doctor's "Restart agent?" repair item, answered independently of "Rotate node credential?"). Rotation always implies a restart regardless of this flag - see the module doc comment on the `enable --now` bug this exists to avoid repeating. */
  forceRestart?: boolean;
};

/**
 * The one function attach and doctor repair use for the entire
 * credential+agent-install+heartbeat sequence (Part 2 steps 1-8), whether
 * or not rotation actually turns out to be necessary - avoids each caller
 * duplicating "register, install, wait for heartbeat" (see
 * DEPLOYMENT.md "Automatic credential recovery"). When `rotate` is false,
 * this still refreshes the node's coordinator-side metadata and runs the
 * runtime-appropriate install/converge step (role/config could have
 * changed even if the credential didn't), but never touches the
 * credential file and never forces a restart on its account.
 */
export type CredentialRepairNode = Awaited<ReturnType<typeof registerOrRotateNode>>["node"];

export async function rotateAndInstallCredential(
  prisma: PrismaClient,
  input: CredentialInstallInput & { rotate: boolean },
): Promise<{ ok: boolean; rotated: boolean; steps: ConvergenceStep[]; node: CredentialRepairNode | null }> {
  const steps: ConvergenceStep[] = [];

  let registered: Awaited<ReturnType<typeof registerOrRotateNode>>;
  try {
    registered = await registerOrRotateNode(prisma, { ...input.registerInput, rotateCredential: input.rotate });
  } catch (error) {
    steps.push({ name: "credential-revoke", status: "failed", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, rotated: input.rotate, steps, node: null };
  }
  if (input.rotate) {
    steps.push({ name: "credential-revoke", status: "completed", detail: "Previous active credential (if any) revoked." });
    steps.push({ name: "credential-create", status: "completed", detail: "New credential generated on the coordinator." });
  } else {
    steps.push({ name: "credential-reuse", status: "completed", detail: "Existing credential is valid - left untouched." });
  }

  const heartbeatSince = new Date();

  const forceRestart = input.rotate || Boolean(input.forceRestart);
  let installOk: boolean;
  if (input.runtime === "node") {
    const convergence = await convergeNodeRole({
      target: { kind: "remote", sshHost: input.sshHost, repoPath: input.repoPath },
      role: input.role,
      coordinatorUrl: input.coordinatorUrl,
      nodeName: input.nodeName,
      spoolRoot: input.spoolRoot,
      credential: registered.credential || null,
      startServices: true,
      remoteUser: input.remoteUser,
      forceRestart,
    });
    steps.push(...convergence.steps);
    installOk = convergence.ok;
  } else {
    const configConvergence = await convergeEdgeAgentConfig(input.sshHost, {
      role: input.role === "camera-node" ? "camera-node" : "greenhouse-node",
      nodeName: input.nodeName ?? input.registerInput.name,
      coordinatorUrl: input.coordinatorUrl,
      spoolRoot: input.spoolRoot,
      capabilities: input.registerInput.capabilities ?? ["camera"],
    });
    steps.push({
      name: "edge-config",
      status: configConvergence.ok ? "completed" : "failed",
      detail: `${configConvergence.status}: ${configConvergence.detail}${configConvergence.configPath ? ` (${configConvergence.configPath})` : ""}`,
    });
    if (!configConvergence.ok) {
      installOk = false;
    } else {
      const install = await installEdgeAgentCredential({
        sshHost: input.sshHost,
        credential: registered.credential || null,
        forceRestart: forceRestart || configConvergence.status === "UPDATED",
      });
      steps.push(...install.steps);
      installOk = install.ok;
    }
  }

  if (!installOk) {
    await markNodeStatus(prisma, registered.node.id, "repair-required");
    return { ok: false, rotated: input.rotate, steps, node: registered.node };
  }

  if (input.waitForHeartbeat === false) {
    steps.push({ name: "heartbeat", status: "skipped", detail: "Heartbeat wait skipped by caller." });
    return { ok: true, rotated: input.rotate, steps, node: registered.node };
  }

  const heartbeat = await waitForNodeHeartbeat(prisma, registered.node.id, heartbeatSince, input.heartbeatTimeoutMs ?? 45_000);
  if (!heartbeat) {
    steps.push({ name: "heartbeat", status: "failed", detail: "No authenticated heartbeat received." });
    await markNodeStatus(prisma, registered.node.id, "repair-required");
    return { ok: false, rotated: input.rotate, steps, node: registered.node };
  }
  steps.push({ name: "heartbeat", status: "completed", detail: "Authenticated heartbeat received." });
  await markNodeStatus(prisma, registered.node.id, "pending");

  return { ok: true, rotated: input.rotate, steps, node: registered.node };
}

/**
 * Probes first (Part 1), then always runs rotateAndInstallCredential() -
 * with rotation only when the probe demonstrates the credential is
 * actually unusable (Part 4: "use them from attach and doctor repair
 * instead of duplicating behavior"). This is the single call attach/doctor
 * need for the whole credential+install+heartbeat sequence.
 */
export async function ensureValidNodeCredential(
  prisma: PrismaClient,
  input: CredentialInstallInput,
): Promise<{ ok: boolean; rotated: boolean; probe: CredentialProbeResult; steps: ConvergenceStep[]; node: CredentialRepairNode | null }> {
  const probe = await probeRemoteCredential({ sshHost: input.sshHost, coordinatorUrl: input.coordinatorUrl, remoteUser: input.remoteUser });
  const rotate = INVALID_STATUSES.has(probe.status);

  const result = await rotateAndInstallCredential(prisma, { ...input, rotate });
  return { ...result, probe };
}
