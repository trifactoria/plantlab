import { randomUUID } from "node:crypto";
import {
  collectSupportBundle,
  selectedHostsForRequest,
  type ScreenshotMode,
  type SupportCollectionRequest,
  type SupportTargetStatus,
} from "./supportCollect";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/supportBundleJobs.ts is server-only operational code.");
}

export type SupportBundleScope = "coordinator" | "nodes" | "all";

export type SupportBundleRequest = {
  scope: SupportBundleScope;
  nodes?: string[];
  screenshots: ScreenshotMode;
  includeLogs: boolean;
  includeHardwareTests: boolean;
};

type Target = { host: string; role: string; status: SupportTargetStatus };

type SupportBundleJob = {
  id: string;
  request: SupportBundleRequest;
  normalizedRequest: SupportCollectionRequest;
  status: "running" | "succeeded" | "partial" | "failed";
  targets: Target[];
  screenshots: { mode: ScreenshotMode; status: "queued" | "collecting" | "succeeded" | "failed" | "skipped" };
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  invokedOn: string;
  error: string | null;
  result: { filename: string; size: number; probes: number; failures: number } | null;
  zipPath: string | null;
};

// A single coordinator web process (plantlab-web) serves the UI, so a
// process-global registry is sufficient. It lives on globalThis so every
// route module (and dev-mode HMR reload) shares the same instance, the same
// way src/lib/prisma.ts shares one PrismaClient. Jobs are ephemeral
// diagnostics - losing them on a restart is acceptable and they are pruned
// by age.
const globalForSupportJobs = globalThis as unknown as { __plantlabSupportJobs?: Map<string, SupportBundleJob> };
const JOBS: Map<string, SupportBundleJob> = globalForSupportJobs.__plantlabSupportJobs ?? new Map();
globalForSupportJobs.__plantlabSupportJobs = JOBS;
const MAX_JOB_AGE_MS = 60 * 60_000;

function prune() {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  for (const [id, job] of JOBS) {
    if (job.completedAt && new Date(job.completedAt).getTime() < cutoff) JOBS.delete(id);
  }
}

/** Maps the structured UI request to the canonical collector request - never a shelled command string. */
export function toSupportCollectionRequest(request: SupportBundleRequest): SupportCollectionRequest {
  const base = {
    coordinator: "plantlab",
    screenshotMode: request.screenshots,
    includeLogs: request.includeLogs,
    includeHardwareDiagnostics: request.includeHardwareTests,
  };
  if (request.scope === "all") return { ...base, scope: "all", nodeNames: [] };
  if (request.scope === "nodes") return { ...base, scope: "selected-nodes", nodeNames: (request.nodes ?? []).slice(0, 8) };
  return { ...base, scope: "coordinator", nodeNames: [] };
}

export function createSupportBundleJob(request: SupportBundleRequest): SupportBundleJob {
  prune();
  const normalizedRequest = toSupportCollectionRequest(request);
  const hosts = selectedHostsForRequest(normalizedRequest);
  const id = randomUUID();
  const job: SupportBundleJob = {
    id,
    request,
    normalizedRequest,
    status: "running",
    targets: hosts.map((host) => ({ host: host.host, role: host.role, status: "queued" })),
    screenshots: { mode: request.screenshots, status: request.screenshots === "none" ? "skipped" : "queued" },
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    invokedOn: "coordinator",
    error: null,
    result: null,
    zipPath: null,
  };
  JOBS.set(id, job);

  const startedAtMs = Date.now();
  void collectSupportBundle({
    all: normalizedRequest.scope === "all",
    nodes: normalizedRequest.scope === "selected-nodes" ? normalizedRequest.nodeNames : [],
    coordinator: normalizedRequest.coordinator,
    screenshots: normalizedRequest.screenshotMode,
    includeLogs: normalizedRequest.includeLogs,
    includeHardwareTests: normalizedRequest.includeHardwareDiagnostics,
    onProgress: (event) => {
      if (event.type === "target-start") {
        const target = job.targets.find((candidate) => candidate.host === event.host);
        if (target) target.status = "collecting";
      } else if (event.type === "target-done") {
        const target = job.targets.find((candidate) => candidate.host === event.host);
        if (target) target.status = event.status;
      } else if (event.type === "screenshots-start") {
        job.screenshots.status = "collecting";
      } else if (event.type === "screenshots-done") {
        job.screenshots.status = event.ok ? "succeeded" : "failed";
      }
    },
  })
    .then((result) => {
      const failures = result.manifest.probes.filter((probe) => !probe.ok).length;
      job.result = { filename: result.filename, size: result.size, probes: result.manifest.probes.length, failures };
      job.zipPath = result.zipPath;
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAtMs;
      const anyFailed = job.targets.some((target) => target.status === "failed" || target.status === "partial") || job.screenshots.status === "failed";
      job.status = anyFailed ? "partial" : "succeeded";
    })
    .catch((error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAtMs;
      for (const target of job.targets) if (target.status === "queued" || target.status === "collecting") target.status = "failed";
    });

  return job;
}

export function getSupportBundleJob(id: string): SupportBundleJob | null {
  return JOBS.get(id) ?? null;
}

export function serializeSupportBundleJob(job: SupportBundleJob) {
  const { zipPath, ...rest } = job;
  return { ...rest, downloadReady: Boolean(zipPath) && job.status !== "failed" };
}
