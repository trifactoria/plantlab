// Canonical coordinator URL discovery (Part 1 of the stabilization task).
//
// The exact bug this fixes: `node attach`/`doctor --fix` always defaulted
// to `http://${os.hostname()}:3000` (defaultCoordinatorUrl() in
// remoteNode.ts) - the coordinator's *own* hostname, which is only ever
// resolvable from the coordinator itself. On greenhouse-zero (a Raspberry
// Pi with no DNS entry for the coordinator's SSH alias/hostname "plantlab")
// this produced exactly the reported failure: "Name or service not known".
//
// This module never trusts a coordinator URL until the *target* node has
// proven - via a real curl round trip run on that node - that it can reach
// `GET /api/node-info` and get back a genuine PlantLab coordinator
// response. Candidates are tried in order and the first one that passes
// wins; if none pass, discovery returns null and callers must stop before
// writing any config or touching credentials.

import os from "node:os";
import { runLocalShell, runRemoteShell, validateSshHost } from "./shellExec";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/coordinatorDiscovery.ts shells out to ssh and must not run in a browser.");
}

export type CoordinatorCandidate = { url: string; source: string };

export type CoordinatorAttempt = CoordinatorCandidate & {
  reachable: boolean;
  detail: string;
};

export type CoordinatorDiscoveryResult = {
  selected: string | null;
  attempts: CoordinatorAttempt[];
};

const DEFAULT_PORT = 3000;

/** LAN-range check mirroring remoteNode.ts's INSPECT_SCRIPT categorization (10.x/172.16-31.x/192.168.x, excluding common bridge/container ranges). */
function isLikelyLanIPv4(address: string): boolean {
  if (/^192\.168\.122\.|^172\.1[7-9]\.|^172\.2\d\.|^172\.3[01]\.|^10\.42\./.test(address)) return false; // common libvirt/docker/k8s bridge ranges
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/** This machine's own LAN IPv4 addresses (the coordinator's, when discovery runs from `node attach`/`doctor --fix`). */
function localLanIPv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isLikelyLanIPv4(entry.address)) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

async function localTailscaleAddresses(): Promise<{ ipv4: string | null; magicDns: string | null }> {
  const result = await runLocalShell(
    String.raw`
if command -v tailscale >/dev/null 2>&1; then
  ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  dns="$(tailscale status --json 2>/dev/null | python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('Self',{}).get('DNSName','').rstrip('.'))
except Exception:
    print('')" 2>/dev/null || true)"
  printf 'IP=%s\n' "$ip"
  printf 'DNS=%s\n' "$dns"
fi
`,
  ).catch(() => ({ stdout: "", stderr: "", status: 1 }));
  const ipMatch = /^IP=(.*)$/m.exec(result.stdout);
  const dnsMatch = /^DNS=(.*)$/m.exec(result.stdout);
  return {
    ipv4: ipMatch?.[1]?.trim() || null,
    magicDns: dnsMatch?.[1]?.trim() || null,
  };
}

/**
 * Assembles ordered candidate coordinator URLs - explicit flag first (if
 * given), then a configured canonical URL, then this machine's LAN
 * IPv4(s), then Tailscale IP/MagicDNS, then local hostname/mDNS. Every
 * candidate is still tested from the remote node before use - this
 * function never decides reachability itself.
 */
export async function buildCoordinatorCandidates(explicitUrl?: string | null, port: number = DEFAULT_PORT): Promise<CoordinatorCandidate[]> {
  const candidates: CoordinatorCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, source: string) => {
    const normalized = url.replace(/\/+$/, "");
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ url: normalized, source });
  };

  if (explicitUrl && explicitUrl.trim()) {
    add(explicitUrl.trim(), "explicitly supplied --coordinator-url");
  }

  const canonical = process.env.PLANTLAB_CANONICAL_COORDINATOR_URL;
  if (canonical && canonical.trim()) {
    add(canonical.trim(), "configured canonical coordinator URL");
  }

  for (const ip of localLanIPv4Addresses()) {
    add(`http://${ip}:${port}`, "coordinator LAN IPv4");
  }

  const tailscale = await localTailscaleAddresses();
  if (tailscale.ipv4) add(`http://${tailscale.ipv4}:${port}`, "Tailscale IPv4");
  if (tailscale.magicDns) add(`http://${tailscale.magicDns}:${port}`, "Tailscale MagicDNS");

  const hostname = os.hostname();
  if (hostname) {
    add(`http://${hostname}:${port}`, "local hostname");
    add(`http://${hostname}.local:${port}`, "mDNS hostname");
  }

  return candidates;
}

/**
 * Tests every candidate from the *target* node itself (one SSH round trip
 * covers all candidates) via `GET /api/node-info`, requiring the response
 * to actually look like a PlantLab coordinator (not just any HTTP 200) -
 * see Part 1 "Use the first reachable valid PlantLab coordinator
 * endpoint." Never writes anything; purely a probe.
 */
export async function discoverCoordinatorUrl(
  sshHost: string,
  options: { explicitUrl?: string | null; port?: number; log?: (line: string) => void } = {},
): Promise<CoordinatorDiscoveryResult> {
  validateSshHost(sshHost);
  const candidates = await buildCoordinatorCandidates(options.explicitUrl, options.port ?? DEFAULT_PORT);
  const log = options.log ?? (() => {});

  if (candidates.length === 0) {
    return { selected: null, attempts: [] };
  }

  log(`Testing coordinator addresses from ${sshHost}...`);
  log("");

  const candidateLines = candidates.map((candidate) => `${candidate.source}|${candidate.url}`).join("\n");
  // Deliberately `set -u` only, never `set -e`: under `set -e`, a failing
  // curl inside `var="$(curl ...)"` aborts the *whole script* immediately
  // in dash (Raspberry Pi OS Lite's /bin/sh) before the next line can
  // capture `$?` - verified empirically against a real Pi. The
  // `|| status=$?` idiom below is what actually lets a failed candidate
  // fall through to the next one instead of killing the rest of the probe.
  const script = String.raw`
set -u
while IFS='|' read -r source url; do
  [ -z "$url" ] && continue
  if ! command -v curl >/dev/null 2>&1; then
    echo "FAIL|$source|$url|curl is not installed on this node"
    continue
  fi
  err_file="$(mktemp)"
  status=0
  body="$(curl -fsS --max-time 5 "$url/api/node-info" 2>"$err_file")" || status=$?
  err="$(cat "$err_file" 2>/dev/null || true)"
  rm -f "$err_file"
  if [ "$status" -eq 0 ] && printf '%s' "$body" | grep -q '"coordinatorName"'; then
    echo "PASS|$source|$url|PlantLab coordinator reachable"
    continue
  fi
  case "$status" in
    6) reason="Name or service not known" ;;
    7) reason="Connection refused" ;;
    28) reason="Connection timed out" ;;
    0) reason="Responded, but did not look like a PlantLab coordinator" ;;
    *) reason="$(printf '%s' "$err" | tail -n1)"; [ -z "$reason" ] && reason="curl exited $status" ;;
  esac
  echo "FAIL|$source|$url|$reason"
done <<'CANDIDATES_EOF'
${candidateLines}
CANDIDATES_EOF
`;

  const result = await runRemoteShell(sshHost, script, [], { timeoutMs: Math.max(10_000, candidates.length * 7_000) }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    status: 255,
  }));

  const attempts: CoordinatorAttempt[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^(PASS|FAIL)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, verdict, source, url, detail] = match;
    attempts.push({ url, source, reachable: verdict === "PASS", detail });
  }

  for (const attempt of attempts) {
    log(`${attempt.reachable ? "PASS" : "FAIL"} ${attempt.url}`);
    log(`     ${attempt.detail}`);
    log("");
  }

  const selected = attempts.find((attempt) => attempt.reachable)?.url ?? null;
  if (selected) {
    log("Selected coordinator:");
    log(selected);
  }

  return { selected, attempts };
}
