"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ScreenshotMode = "none" | "fixture" | "live-readonly";
type Scope = "coordinator" | "nodes" | "all";

type Target = { host: string; role: string; status: "queued" | "collecting" | "succeeded" | "partial" | "failed" };
type Job = {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  targets: Target[];
  screenshots: { mode: ScreenshotMode; status: "queued" | "collecting" | "succeeded" | "failed" | "skipped" };
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: { filename: string; size: number; probes: number; failures: number } | null;
  downloadReady: boolean;
};

const STATUS_TONE: Record<string, string> = {
  queued: "border-stone-200 bg-stone-100 text-stone-600",
  collecting: "border-sky-200 bg-sky-100 text-sky-900",
  succeeded: "border-emerald-200 bg-emerald-100 text-emerald-900",
  partial: "border-amber-200 bg-amber-100 text-amber-900",
  failed: "border-red-200 bg-red-100 text-red-900",
  skipped: "border-stone-200 bg-stone-100 text-stone-500",
};

const SCREENSHOT_HELP: Record<ScreenshotMode, string> = {
  none: "No screenshots are captured.",
  fixture: "Uses a temporary, isolated PlantLab database and synthetic data. It never accesses the live coordinator database.",
  "live-readonly": "Captures the current live pages using navigation and GET-only behavior. It does not create, edit, delete, toggle, or run diagnostics.",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SupportBundlePanel({ nodeNames }: { nodeNames: string[] }) {
  const [scope, setScope] = useState<Scope>("coordinator");
  const [selectedNodes, setSelectedNodes] = useState<string[]>(nodeNames.slice(0, 1));
  const [screenshots, setScreenshots] = useState<ScreenshotMode>("none");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [includeHardwareTests, setIncludeHardwareTests] = useState(false);

  const [job, setJob] = useState<Job | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const poll = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/support-bundles/${jobId}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      setJob(body.job);
      if (body.job.status !== "running" && pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      // transient - keep polling
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  async function start() {
    setStarting(true);
    setSubmitError(null);
    try {
      const response = await fetch("/api/support-bundles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, nodes: scope === "nodes" ? selectedNodes : [], screenshots, includeLogs, includeHardwareTests }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSubmitError(body.error ?? "Could not start the support bundle.");
        return;
      }
      setJob(body.job);
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(() => void poll(body.job.id), 2000);
    } catch {
      setSubmitError("Could not reach the coordinator.");
    } finally {
      setStarting(false);
    }
  }

  function toggleNode(name: string) {
    setSelectedNodes((prev) => (prev.includes(name) ? prev.filter((node) => node !== name) : [...prev, name]));
  }

  const running = job?.status === "running";

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">New support bundle</h2>
        <p className="mt-1 text-sm text-stone-600">Collects read-only diagnostics from the coordinator and selected nodes into a downloadable ZIP. Secrets and credentials are redacted.</p>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-stone-800">Scope</legend>
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            {(["coordinator", "nodes", "all"] as Scope[]).map((value) => (
              <label key={value} className="inline-flex items-center gap-2">
                <input type="radio" name="scope" checked={scope === value} onChange={() => setScope(value)} />
                {value === "coordinator" ? "Coordinator only" : value === "nodes" ? "Selected node(s)" : "All hosts"}
              </label>
            ))}
          </div>
        </fieldset>

        {scope === "nodes" ? (
          <fieldset className="mt-3">
            <legend className="text-sm font-medium text-stone-800">Nodes</legend>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {nodeNames.length === 0 ? <span className="text-stone-500">No registered nodes.</span> : null}
              {nodeNames.map((name) => (
                <label key={name} className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={selectedNodes.includes(name)} onChange={() => toggleNode(name)} />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-stone-800">Screenshots</legend>
          <div className="mt-2 grid grid-cols-1 gap-2 text-sm">
            {(["none", "fixture", "live-readonly"] as ScreenshotMode[]).map((value) => (
              <label key={value} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 ${screenshots === value ? "border-emerald-300 bg-emerald-50" : "border-stone-200 bg-white"}`}>
                <input type="radio" name="screenshots" className="mt-0.5" checked={screenshots === value} onChange={() => setScreenshots(value)} />
                <span>
                  <span className="font-medium text-stone-900">{value === "none" ? "None" : value === "fixture" ? "Fixture (synthetic, isolated)" : "Live read-only"}</span>
                  <span className="block text-xs text-stone-600">{SCREENSHOT_HELP[value]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-stone-800">Contents</legend>
          <div className="mt-2 grid grid-cols-1 gap-2 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includeLogs} onChange={(event) => setIncludeLogs(event.target.checked)} />
              Include recent service logs
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includeHardwareTests} onChange={(event) => setIncludeHardwareTests(event.target.checked)} />
              Run sensor hardware tests on edge nodes
              <span className="text-xs text-amber-700">(intrusive - reads real sensors; off by default)</span>
            </label>
          </div>
        </fieldset>

        {submitError ? <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">{submitError}</p> : null}

        <div className="mt-4">
          <button type="button" className="button" disabled={starting || running} onClick={start}>
            {starting ? "Starting..." : running ? "Collecting..." : "Generate support bundle"}
          </button>
        </div>
      </div>

      {job ? <JobProgress job={job} /> : null}
    </div>
  );
}

function JobProgress({ job }: { job: Job }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-950">Collection {job.status === "running" ? "in progress" : job.status}</h2>
        <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[job.status] ?? STATUS_TONE.queued}`}>{job.status}</span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2">
        {job.targets.map((target) => (
          <div key={target.host} className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-sm">
            <span>
              <span className="font-medium text-stone-900">{target.host}</span> <span className="text-xs text-stone-500">({target.role})</span>
            </span>
            <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[target.status]}`}>{target.status}</span>
          </div>
        ))}
        {job.screenshots.mode !== "none" ? (
          <div className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-sm">
            <span>
              <span className="font-medium text-stone-900">Screenshots</span> <span className="text-xs text-stone-500">({job.screenshots.mode})</span>
            </span>
            <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[job.screenshots.status]}`}>{job.screenshots.status}</span>
          </div>
        ) : null}
      </div>

      {job.error ? <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">{job.error}</p> : null}

      {job.result ? (
        <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
          <dl className="grid grid-cols-1 gap-1 text-xs text-stone-600 sm:grid-cols-2">
            <Row label="File" value={job.result.filename} />
            <Row label="Size" value={formatBytes(job.result.size)} />
            <Row label="Probes" value={String(job.result.probes)} />
            <Row label="Probe failures" value={String(job.result.failures)} />
            <Row label="Duration" value={job.durationMs !== null ? `${(job.durationMs / 1000).toFixed(1)}s` : "-"} />
          </dl>
          {job.downloadReady ? (
            <a href={`/api/support-bundles/${job.id}/download`} className="button mt-3 inline-flex">
              Download ZIP
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-mono text-stone-800">{value}</dd>
    </div>
  );
}
