"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

export type ProjectCropStatusData = {
  totalPlants: number;
  configuredCount: number;
  legacyOnlyCount: number;
  unconfiguredCount: number;
  automaticAssignmentDisabledCount: number;
  totalProjectPhotos: number;
  totalApplicableFrames: number;
  totalMaterializedFrames: number;
};

type SyncReport = {
  totalPlants: number;
  configuredCount: number;
  unconfiguredCount: number;
  added: number;
  skippedExisting: number;
  preservedManual: number;
  failed: number;
};

/**
 * Project-level crop-readiness status, shown near the plant grid so nobody
 * has to open every plant page to know whether it's ready. "Configure
 * Project Crops" opens the guided wizard; "Sync Visual Histories" calls the
 * same shared repair service as each plant's own "Fill missing frames".
 */
export function ProjectCropStatus({
  projectId,
  status,
}: {
  projectId: string;
  status: ProjectCropStatusData;
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remaining = status.unconfiguredCount + status.legacyOnlyCount;
  const activeAutomaticCount = status.configuredCount - status.automaticAssignmentDisabledCount;

  async function runSync() {
    setSyncing(true);
    setError(null);
    setSyncReport(null);
    const response = await fetch(`/api/projects/${projectId}/visual-history/sync`, { method: "POST" });
    const payload = (await response.json()) as SyncReport & { error?: string };
    setSyncing(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not synchronize visual histories.");
      return;
    }

    setSyncReport(payload);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-stone-950">Crop Setup</h2>
      <dl className="mt-3 grid gap-2 text-sm">
        <div>
          <dt className="font-medium text-stone-950">Crop setup</dt>
          <dd className="text-stone-600">
            {status.configuredCount} of {status.totalPlants} plants configured
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-950">Visual histories</dt>
          <dd className="text-stone-600">
            {status.totalMaterializedFrames} of {status.totalApplicableFrames} applicable frames
          </dd>
        </div>
        <div>
          <dt className="font-medium text-stone-950">Automatic future assignment</dt>
          <dd className="text-stone-600">
            active for {activeAutomaticCount} plant{activeAutomaticCount === 1 ? "" : "s"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/projects/${projectId}/crop-setup`} className="button">
          Configure Project Crops
        </Link>
        <button type="button" className="button-secondary" onClick={runSync} disabled={syncing}>
          {syncing ? "Syncing..." : "Sync Visual Histories"}
        </button>
        {remaining > 0 ? (
          <Link href={`/projects/${projectId}/crop-setup?filter=unconfigured`} className="button-secondary">
            View Unconfigured Plants ({remaining})
          </Link>
        ) : null}
      </div>

      {syncReport ? (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="font-semibold">Visual histories synchronized</p>
          <p>{syncReport.totalPlants} plants</p>
          <p>{syncReport.configuredCount} configured</p>
          {syncReport.unconfiguredCount > 0 ? <p>{syncReport.unconfiguredCount} need initial crops</p> : null}
          <p className="mt-2">{syncReport.added} missing frames added</p>
          <p>{syncReport.skippedExisting} existing frames preserved</p>
          <p>{syncReport.preservedManual} manual crops preserved</p>
          <p>{syncReport.failed} failures</p>
          {syncReport.unconfiguredCount > 0 ? (
            <Link
              href={`/projects/${projectId}/crop-setup?filter=unconfigured`}
              className="mt-2 inline-flex font-semibold text-emerald-800 underline"
            >
              Continue configuring the remaining {syncReport.unconfiguredCount} plant
              {syncReport.unconfiguredCount === 1 ? "" : "s"}
            </Link>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
    </div>
  );
}
