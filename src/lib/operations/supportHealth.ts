import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/supportHealth.ts is server-only operational code.");
}

export type SupportHealthLevel = "healthy" | "warning" | "critical" | "unknown";

export type SupportFinding = {
  level: Exclude<SupportHealthLevel, "unknown">;
  host: string;
  role: string;
  category: string;
  title: string;
  detail: string;
  evidencePath?: string;
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
    findings.push({
      level: command.includes("curl") || text.includes("connection refused") || text.includes("could not connect") ? "critical" : "warning",
      host: probe.host,
      role: probe.role,
      category: "probe",
      title: "Probe command failed",
      detail: `${probe.command} exited with status ${probe.status ?? "unknown"}.`,
      evidencePath,
      suggestedNextStep: "Open the evidence file and inspect stderr/stdout for the failed probe.",
    });
  }

  if (/\bactive:\s+failed\b/i.test(output)) {
    findings.push({
      level: "critical",
      host: probe.host,
      role: probe.role,
      category: "services",
      title: "systemd service is failed",
      detail: "The service status output reports Active: failed.",
      evidencePath,
      suggestedNextStep: "Inspect the matching journal log in the bundle before restarting the service.",
    });
  }

  if (/\bloaded:\s+not-found\b/i.test(output)) {
    findings.push({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "services",
      title: "Expected service unit is missing",
      detail: "The service status output reports Loaded: not-found.",
      evidencePath,
      suggestedNextStep: "Confirm whether this host is expected to run that PlantLab service.",
    });
  }

  if (text.includes("coordinator unreachable") || text.includes("connection refused") || text.includes("could not connect to server")) {
    findings.push({
      level: "critical",
      host: probe.host,
      role: probe.role,
      category: "network",
      title: "PlantLab endpoint unreachable",
      detail: "A coordinator or local API probe could not connect.",
      evidencePath,
      suggestedNextStep: "Check the web service status and host/network reachability.",
    });
  }

  const corruptFrames = countMatches(text, /camera-frame-corrupt|frame corrupt|invalid image|validationstatus[^a-z0-9]+rejected/g);
  if (corruptFrames >= 2) {
    findings.push({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "cameras",
      title: "Repeated camera frame validation problems",
      detail: `${corruptFrames} corrupt or rejected frame signals were found in this output.`,
      evidencePath,
      suggestedNextStep: "Compare requested/effective capture modes and recent camera retry logs.",
    });
  }

  const retries = countMatches(text, /capture retry|retrying capture|fallback used|fallbackmode|capture attempt [2-9]/g);
  if (retries >= 2) {
    findings.push({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "captures",
      title: "Repeated capture retries or fallback use",
      detail: `${retries} retry or fallback signals were found in this output.`,
      evidencePath,
      suggestedNextStep: "Inspect recent capture jobs and source occurrences before changing camera settings.",
    });
  }

  if (/heartbeat[^.\n]*(stale|offline)|"online"\s*:\s*false/.test(text)) {
    findings.push({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "nodes",
      title: "Node heartbeat or online status is degraded",
      detail: "A node summary or diagnostic output reported stale/offline heartbeat state.",
      evidencePath,
      suggestedNextStep: "Compare coordinator node summaries with edge-agent service status and recent logs.",
    });
  }

  const dhtMisses = countMatches(text, /dht22[^.\n]*(miss|failed|timeout|checksum|rejected)|sensor[^.\n]*(timeout|checksum)/g);
  if (dhtMisses >= 4) {
    findings.push({
      level: "warning",
      host: probe.host,
      role: probe.role,
      category: "sensors",
      title: "Repeated DHT22 read misses",
      detail: `${dhtMisses} DHT22 miss/failure signals were found. A single transient miss is not treated as failed.`,
      evidencePath,
      suggestedNextStep: "Review canonical sensor health and consecutive failure counts before changing GPIO or wiring.",
    });
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
  return {
    host,
    role,
    health: overallHealth(hostFindings, probes),
    probeCounts: {
      total: probes.length,
      passed: probes.filter((probe) => probe.ok).length,
      failed: probes.filter((probe) => !probe.ok).length,
    },
    criticalFindings: hostFindings.filter((finding) => finding.level === "critical"),
    warnings: hostFindings.filter((finding) => finding.level === "warning"),
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
  const lines = [
    "# PlantLab Health Report",
    "",
    `Generated: ${input.createdAt}`,
    `Collected on: ${input.invokedOn}`,
    `Overall health: ${health}`,
    `Screenshot mode: ${input.screenshots}`,
    "",
    "## Critical Findings",
    ...findingLines(critical),
    "",
    "## Warnings",
    ...findingLines(warnings),
    "",
    "## Healthy Items",
    ...(healthyProbes.length ? healthyProbes.slice(0, 80).map((probe) => `- ${probe.host}: ${probe.command}`) : ["- No passing probes recorded."]),
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
    "## Skipped Or Failed Probes",
    ...(failedProbes.length ? failedProbes.map((probe) => `- ${probe.host}: ${probe.command} (${probe.status ?? "unknown"})`) : ["- No failed probes recorded."]),
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
    ? findings.map((finding) => `- ${finding.host} [${finding.category}]: ${finding.title}. ${finding.detail}`)
    : ["- None."];
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
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.level}:${finding.host}:${finding.category}:${finding.title}:${finding.evidencePath ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(input: string) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
