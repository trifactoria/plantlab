import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/supportHealth.ts is server-only operational code.");
}

export type SupportHealthLevel = "healthy" | "warning" | "critical" | "unknown";

export type SupportFinding = {
  key?: string;
  level: Exclude<SupportHealthLevel, "unknown">;
  host: string;
  role: string;
  category: string;
  subsystem?: string;
  title: string;
  detail: string;
  summary?: string;
  evidencePath?: string;
  evidence?: Array<{ source: string; path?: string; timestamp?: string; detail?: string }>;
  count?: number;
  suggestedNextStep?: string;
};

export type SupportProbeLike = {
  host: string;
  role: string;
  command: string;
  ok: boolean;
  status: number | null;
  path: string;
  error?: string;
};

export type ScreenshotMetadata = {
  route: string;
  title: string;
  host: string;
  viewport: { width: number; height: number };
  capturedAt: string;
  httpStatus: number | null;
  consoleErrors: string[];
  networkErrors: string[];
  outputFilename: string;
  ready: boolean;
  readinessReason: string | null;
};

export type SupportReportInput = {
  createdAt: string;
  invokedOn: string;
  screenshots: string;
  probes: SupportProbeLike[];
  findings: SupportFinding[];
  screenshotsMetadata: ScreenshotMetadata[];
  uiCoverage?: Array<{
    host: string;
    role: string;
    classification: string;
    baseUrl: string | null;
    reason: string | null;
    discoveredSurfaces: number;
    attempted: number;
    succeeded: number;
    failed: number;
    screenshots: number;
  }>;
  collectionOptions: Record<string, unknown>;
};

const LEVEL_ORDER: Record<SupportHealthLevel, number> = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
};

export function compareHealthLevel(a: SupportHealthLevel, b: SupportHealthLevel): number {
  return LEVEL_ORDER[a] - LEVEL_ORDER[b];
}

export function overallHealth(findings: SupportFinding[], probes: SupportProbeLike[]): SupportHealthLevel {
  if (findings.some((finding) => finding.level === "critical")) return "critical";
  if (findings.some((finding) => finding.level === "warning")) return "warning";
  if (probes.length === 0) return "unknown";
  return "healthy";
}

export function evaluateProbeOutput(probe: SupportProbeLike, output: string): SupportFinding[] {
  const text = output.toLowerCase();
  const findings: SupportFinding[] = [];
  const command = probe.command.toLowerCase();
  const evidencePath = probe.path;

  if (!probe.ok) {
    findings.push(withFindingKey({
      level: command.includes("curl") || text.includes("connection refused") || text.includes("could not connect") ? "critical" : "warning",
      host: probe.host,
      role: probe.role,
      category: "probe",
      subsystem: "probe",
      title: "Probe command failed",
      detail: `${probe.command} exited with status ${probe.status ?? "unknown"}.`,
      evidencePath,
      suggestedNextStep: "Open the evidence file and inspect stderr/stdout for the failed probe.",
    }, probe));
  }

  if (/\bactive:\s+failed\b/i.test(output)) {
    findings.push(withFindingKey({
      level: "critical",
      host: probe.host,
      role: probe.role,
      category: "services",
      subsystem: "services",
      title: "systemd service is failed",
      detail: "The service status output reports Active: failed.",
      evidencePath,
      suggestedNextStep: "Inspect the matching journal log in the bundle before restarting the service.",
    }, probe));
  }

  if (/\bloaded:\s+not-found\b/i.test(output)) {
    findings.push(withFindingKey({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "services",
      subsystem: "services",
      title: "Expected service unit is missing",
      detail: "The service status output reports Loaded: not-found.",
      evidencePath,
      suggestedNextStep: "Confirm whether this host is expected to run that PlantLab service.",
    }, probe));
  }

  if (text.includes("coordinator unreachable") || text.includes("connection refused") || text.includes("could not connect to server")) {
    findings.push(withFindingKey({
      level: "critical",
      host: probe.host,
      role: probe.role,
      category: "network",
      subsystem: "network",
      title: "PlantLab endpoint unreachable",
      detail: "A coordinator or local API probe could not connect.",
      evidencePath,
      suggestedNextStep: "Check the web service status and host/network reachability.",
    }, probe));
  }

  const corruptFrames = countMatches(text, /camera-frame-corrupt|partial-frame|frame corrupt|invalid image|validationstatus[^a-z0-9]+rejected/g);
  if (corruptFrames >= 2) {
    findings.push(withFindingKey({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "cameras",
      subsystem: "cameras",
      title: "Repeated camera frame validation problems",
      detail: `${corruptFrames} corrupt or rejected frame signals were found in this output.`,
      evidencePath,
      count: corruptFrames,
      suggestedNextStep: "Compare requested/effective capture modes and recent camera retry logs.",
    }, probe, "camera-frame-validation"));
  }

  const retries = countMatches(text, /capture retry|retrying capture|fallback used|fallbackused["\s:]+true|capture attempt [2-9]|"attempts"\s*:\s*[2-9]/g);
  if (retries >= 2) {
    findings.push(withFindingKey({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "captures",
      subsystem: "captures",
      title: "Repeated capture retries or fallback use",
      detail: `${retries} retry or fallback signals were found in this output.`,
      evidencePath,
      count: retries,
      suggestedNextStep: "Inspect recent capture jobs and source occurrences before changing camera settings.",
    }, probe, "capture-retry-fallback-runtime"));
  }

  if (/heartbeat[^.\n]*(stale|offline)|"online"\s*:\s*false/.test(text)) {
    const storedFleetRecord = probe.path.includes("api/nodes-summary") || probe.path.includes("api/hardware-sensors") || probe.path.includes("api/hardware-cameras");
    findings.push(withFindingKey({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: storedFleetRecord ? "fleet-state" : "nodes",
      subsystem: storedFleetRecord ? "fleet-state" : "nodes",
      title: storedFleetRecord ? "Stored fleet node record is stale or offline" : "Node heartbeat or online status is degraded",
      detail: storedFleetRecord
        ? "A stored attached-node record in this host's database reports stale/offline heartbeat state. This is distinct from the host's own service health."
        : "A node summary or diagnostic output reported stale/offline heartbeat state.",
      evidencePath,
      suggestedNextStep: "Compare coordinator node summaries with edge-agent service status and recent logs.",
    }, probe, storedFleetRecord ? "stored-fleet-node-stale" : "node-heartbeat-degraded"));
  }

  const dhtMisses = countMatches(text, /dht22[^.\n]*(miss|failed|timeout|checksum|rejected)|sensor[^.\n]*(timeout|checksum)/g);
  if (dhtMisses >= 4) {
    findings.push(withFindingKey({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "sensors",
      subsystem: "sensors",
      title: "Repeated DHT22 read misses",
      detail: `${dhtMisses} DHT22 miss/failure signals were found. A single transient miss is not treated as failed.`,
      evidencePath,
      count: dhtMisses,
      suggestedNextStep: "Review canonical sensor health and consecutive failure counts before changing GPIO or wiring.",
    }, probe, "dht22-repeated-miss"));
  }

  return findings;
}

export async function findingsForProbes(probes: SupportProbeLike[]): Promise<SupportFinding[]> {
  const nested = await Promise.all(
    probes.map(async (probe) => {
      try {
        return evaluateProbeOutput(probe, await readFile(probe.path, "utf8"));
      } catch {
        return [
          {
            level: "warning" as const,
            host: probe.host,
            role: probe.role,
            category: "probe",
            title: "Probe output could not be read",
            detail: `The collector could not read ${probe.path}.`,
            evidencePath: probe.path,
          },
        ];
      }
    }),
  );
  return dedupeFindings(nested.flat());
}

export function hostHealthSummary(host: string, role: string, probes: SupportProbeLike[], findings: SupportFinding[]) {
  const hostFindings = findings.filter((finding) => finding.host === host);
  const serviceFindings = hostFindings.filter((finding) => finding.category !== "fleet-state");
  const fleetFindings = hostFindings.filter((finding) => finding.category === "fleet-state");
  return {
    host,
    role,
    health: overallHealth(serviceFindings, probes),
    hostHealth: overallHealth(serviceFindings, probes),
    fleetRecordHealth: fleetFindings.length > 0 ? overallHealth(fleetFindings, probes) : "healthy",
    probeCounts: {
      total: probes.length,
      passed: probes.filter((probe) => probe.ok).length,
      failed: probes.filter((probe) => !probe.ok).length,
    },
    criticalFindings: serviceFindings.filter((finding) => finding.level === "critical"),
    warnings: serviceFindings.filter((finding) => finding.level === "warning"),
    fleetRecordFindings: fleetFindings,
    healthyItems: probes.filter((probe) => probe.ok).map((probe) => ({ command: probe.command, path: probe.path })),
    failedProbes: probes.filter((probe) => !probe.ok),
  };
}

export function buildSummaryMarkdown(input: SupportReportInput): string {
  const health = overallHealth(input.findings, input.probes);
  const byHost = groupByHost(input.probes);
  const critical = input.findings.filter((finding) => finding.level === "critical");
  const warnings = input.findings.filter((finding) => finding.level === "warning");
  const healthyProbes = input.probes.filter((probe) => probe.ok);
  const failedProbes = input.probes.filter((probe) => !probe.ok);
  const uiCoverage = input.uiCoverage ?? [];
  const hostNames = [...new Set([...input.probes.map((probe) => probe.host), ...uiCoverage.map((coverage) => coverage.host)])];
  const lines = [
    "# PlantLab Health Report",
    "",
    `Generated: ${input.createdAt}`,
    `Collected on: ${input.invokedOn}`,
    `Overall health: ${health}`,
    `Scope: ${String(input.collectionOptions.scope ?? "unknown")}`,
    `Screenshot mode: ${input.screenshots}`,
    `Total probes: ${input.probes.length}`,
    `Total screenshots: ${input.screenshotsMetadata.length}`,
    `Failed probes: ${failedProbes.length}`,
    "",
    "## Host Table",
    "| Host | Role | UI | Screenshots | Host health | Fleet records | Notes |",
    "|---|---|---|---:|---|---|---|",
    ...hostNames.map((host) => hostTableRow(host, input.probes, input.findings, uiCoverage)),
    "",
    "## Critical Findings",
    ...findingLines(critical),
    "",
    "## Warnings",
    ...findingLines(warnings),
    "",
    "## Healthy Items",
    ...(healthyProbes.length ? healthyProbes.slice(0, 80).map((probe) => `- ${probe.host}: ${shortCommand(probe.command)} (${probe.path})`) : ["- No passing probes recorded."]),
    "",
    "## Host Summaries",
    ...[...byHost.entries()].map(([host, probes]) => {
      const hostFindings = input.findings.filter((finding) => finding.host === host);
      return `- ${host}: ${overallHealth(hostFindings, probes)} (${probes.filter((probe) => probe.ok).length}/${probes.length} probes passed)`;
    }),
    "",
    "## Screenshot Index",
    ...(input.screenshotsMetadata.length
      ? input.screenshotsMetadata.map(
          (shot) => {
            const readiness = shot.ready ? "ready" : `not ready: ${shot.readinessReason ?? "unknown"}`;
            return `- ${shot.host} ${shot.route} -> ${shot.outputFilename} (${shot.httpStatus ?? "no HTTP status"}, ${readiness})`;
          },
        )
      : ["- No screenshots captured."]),
    "",
    "## Missing Or Skipped Surfaces",
    ...missingSurfaceLines(uiCoverage),
    "",
    "## Skipped Or Failed Probes",
    ...(failedProbes.length ? failedProbes.map((probe) => `- ${probe.host}: ${shortCommand(probe.command)} (${probe.status ?? "unknown"}, ${probe.path})`) : ["- No failed probes recorded."]),
    "",
    "## Suggested Next Steps",
    ...suggestedNextSteps(input.findings),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildReadmeHtml(summaryMarkdown: string): string {
  const escaped = escapeHtml(summaryMarkdown);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PlantLab Health Report</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.5; max-width: 980px; margin: 32px auto; padding: 0 20px; color: #172016; }
    pre { white-space: pre-wrap; background: #f5f7f2; border: 1px solid #dce3d6; border-radius: 8px; padding: 16px; }
  </style>
</head>
<body>
  <pre>${escaped}</pre>
</body>
</html>
`;
}

export async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function normalizeEvidencePath(root: string, probe: SupportProbeLike): SupportProbeLike {
  return { ...probe, path: path.relative(root, probe.path) || probe.path };
}

function suggestedNextSteps(findings: SupportFinding[]) {
  const steps = [...new Set(findings.map((finding) => finding.suggestedNextStep).filter(Boolean))];
  return steps.length ? steps.map((step) => `- ${step}`) : ["- No immediate action suggested by collected diagnostics."];
}

function findingLines(findings: SupportFinding[]) {
  return findings.length
    ? findings.map((finding) => `- ${finding.host} [${finding.category}]: ${finding.title}. ${finding.detail}${finding.evidence && finding.evidence.length > 1 ? ` Evidence sources: ${finding.evidence.length}.` : ""}`)
    : ["- None."];
}

function hostTableRow(
  host: string,
  probes: SupportProbeLike[],
  findings: SupportFinding[],
  coverage: NonNullable<SupportReportInput["uiCoverage"]>,
) {
  const hostProbes = probes.filter((probe) => probe.host === host);
  const hostFindings = findings.filter((finding) => finding.host === host && finding.category !== "fleet-state");
  const fleetFindings = findings.filter((finding) => finding.host === host && finding.category === "fleet-state");
  const ui = coverage.find((item) => item.host === host);
  const notes = findings
    .filter((finding) => finding.host === host)
    .slice(0, 2)
    .map((finding) => finding.title)
    .join("; ");
  return `| ${host} | ${hostProbes[0]?.role ?? ui?.role ?? "unknown"} | ${ui?.classification ?? "unknown"} | ${ui?.screenshots ?? 0} | ${overallHealth(hostFindings, hostProbes)} | ${fleetFindings.length ? overallHealth(fleetFindings, hostProbes) : "healthy"} | ${notes || "-"} |`;
}

function missingSurfaceLines(coverage: NonNullable<SupportReportInput["uiCoverage"]>) {
  if (coverage.length === 0) return ["- No UI coverage metadata recorded."];
  const lines: string[] = [];
  for (const item of coverage) {
    if (item.classification === "not-applicable") {
      lines.push(`- ${item.host}: no normal web UI (${item.reason ?? "not applicable"}).`);
    } else if (item.classification !== "available") {
      lines.push(`- ${item.host}: UI ${item.classification}${item.reason ? ` (${item.reason})` : ""}.`);
    } else if (item.failed > 0 || item.attempted < item.discoveredSurfaces) {
      lines.push(`- ${item.host}: ${item.succeeded}/${item.discoveredSurfaces} UI surfaces captured; ${item.failed} failed.`);
    }
  }
  return lines.length ? lines : ["- No missing or skipped UI surfaces recorded."];
}

function shortCommand(command: string) {
  const singleLine = command.replace(/\s+/g, " ").trim();
  if (singleLine.includes("python3 - <<")) return singleLine.includes("PLANTLAB_SUPPORT_QUERIES") ? "sqlite diagnostic query" : "sqlite database summary";
  if (singleLine.length <= 160) return singleLine;
  return `${singleLine.slice(0, 157)}...`;
}

function groupByHost(probes: SupportProbeLike[]) {
  const grouped = new Map<string, SupportProbeLike[]>();
  for (const probe of probes) grouped.set(probe.host, [...(grouped.get(probe.host) ?? []), probe]);
  return grouped;
}

function countMatches(input: string, regex: RegExp) {
  return [...input.matchAll(regex)].length;
}

function dedupeFindings(findings: SupportFinding[]) {
  const byKey = new Map<string, SupportFinding>();
  for (const finding of findings) {
    const key = finding.key ?? `${finding.level}:${finding.host}:${finding.category}:${finding.title}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding, key, evidence: finding.evidence ?? evidenceForFinding(finding), count: finding.count ?? 1 });
      continue;
    }
    existing.level = compareHealthLevel(existing.level, finding.level) >= 0 ? existing.level : finding.level;
    existing.count = (existing.count ?? 1) + (finding.count ?? 1);
    existing.evidence = dedupeEvidence([...(existing.evidence ?? []), ...(finding.evidence ?? evidenceForFinding(finding))]);
    if (!existing.evidencePath && finding.evidencePath) existing.evidencePath = finding.evidencePath;
  }
  return [...byKey.values()];
}

function withFindingKey(finding: SupportFinding, probe: SupportProbeLike, issueCode?: string): SupportFinding {
  const code = issueCode ?? finding.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    ...finding,
    key: `${probe.host}:${finding.category}:${code}`,
    summary: finding.detail,
    evidence: evidenceForFinding(finding, probe),
  };
}

function evidenceForFinding(finding: SupportFinding, probe?: SupportProbeLike) {
  return [
    {
      source: probe ? shortCommand(probe.command) : finding.category,
      path: finding.evidencePath,
      detail: finding.detail,
    },
  ];
}

function dedupeEvidence(evidence: NonNullable<SupportFinding["evidence"]>) {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.source}:${item.path ?? ""}:${item.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(input: string) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
