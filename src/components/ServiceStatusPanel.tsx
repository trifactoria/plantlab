"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";

type ProjectStatus = {
  projectId: string;
  name: string;
  captureEnabled: boolean;
  eligible: boolean;
  errors: string[];
  nextCaptureAt: string | null;
  lastSuccessfulCaptureAt: string | null;
  lastError: { message: string; at: string } | null;
};

type StatusResponse = {
  service: {
    health: "running" | "stale" | "offline";
    lastHeartbeat: string | null;
    startedAt: string | null;
    pid: number | null;
  };
  activeProjectCount: number;
  nextScheduledCaptureAt: string | null;
  projects: ProjectStatus[];
};

const HEALTH_STYLES: Record<StatusResponse["service"]["health"], string> = {
  running: "bg-emerald-100 text-emerald-900 border-emerald-200",
  stale: "bg-amber-100 text-amber-900 border-amber-200",
  offline: "bg-red-100 text-red-900 border-red-200",
};

const HEALTH_LABEL: Record<StatusResponse["service"]["health"], string> = {
  running: "Running",
  stale: "Stale",
  offline: "Offline",
};

export function ServiceStatusPanel() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/service-status", { cache: "no-store" });
    if (!response.ok) {
      setError("Could not load capture service status.");
      return;
    }

    setError(null);
    setStatus((await response.json()) as StatusResponse);
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  const enabledProjects = status?.projects.filter((project) => project.captureEnabled) ?? [];

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-stone-950">Capture Service</h2>
        <code className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-600">pnpm camera:service</code>
      </div>

      {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}

      {status ? (
        <div className="mt-4 grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${HEALTH_STYLES[status.service.health]}`}
            >
              {HEALTH_LABEL[status.service.health]}
            </span>
            <span className="text-sm text-stone-600">
              Last heartbeat:{" "}
              {status.service.lastHeartbeat ? formatDateTime(status.service.lastHeartbeat) : "never"}
            </span>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-stone-950">Active capture projects</dt>
              <dd className="text-stone-600">{status.activeProjectCount}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Next scheduled capture</dt>
              <dd className="text-stone-600">
                {status.nextScheduledCaptureAt ? formatDateTime(status.nextScheduledCaptureAt) : "None scheduled"}
              </dd>
            </div>
          </dl>

          {enabledProjects.length > 0 ? (
            <div className="overflow-x-auto rounded-md border border-stone-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs font-semibold uppercase text-stone-600">
                  <tr>
                    <th className="px-3 py-2">Project</th>
                    <th className="px-3 py-2">Next capture</th>
                    <th className="px-3 py-2">Last success</th>
                    <th className="px-3 py-2">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {enabledProjects.map((project) => (
                    <tr key={project.projectId} className="border-t border-stone-100">
                      <td className="px-3 py-2 font-medium text-stone-950">{project.name}</td>
                      <td className="px-3 py-2 text-stone-600">
                        {project.eligible
                          ? project.nextCaptureAt
                            ? formatDateTime(project.nextCaptureAt)
                            : "-"
                          : `Not eligible: ${project.errors[0] ?? "invalid configuration"}`}
                      </td>
                      <td className="px-3 py-2 text-stone-600">
                        {project.lastSuccessfulCaptureAt ? formatDateTime(project.lastSuccessfulCaptureAt) : "None yet"}
                      </td>
                      <td className="px-3 py-2 text-red-700">
                        {project.lastError ? project.lastError.message : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">
              No projects have scheduled capture enabled.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone-600">Loading capture service status...</p>
      )}
    </div>
  );
}
