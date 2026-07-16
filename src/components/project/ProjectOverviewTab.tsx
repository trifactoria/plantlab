import Image from "next/image";
import Link from "next/link";
import { CapturePhotoButton } from "@/components/CapturePhotoButton";
import type { ProjectSensorBindingView } from "@/components/ProjectEnvironmentPanel";
import { SummaryCard } from "@/components/shell/SummaryCard";
import { StatusBadge } from "@/components/shell/StatusBadge";
import { celsiusToFahrenheit } from "@/lib/greenhouseDisplay";
import { formatDateTime } from "@/lib/format";
import { formatDateTimeInZone } from "@/lib/timezone";
import type { ProjectCameraSummaryView } from "./ProjectCameraTab";

type OverviewProject = {
  id: string;
  name: string;
  description: string | null;
  isTestProject: boolean;
  gridWidth: number;
  gridHeight: number;
  timeZone: string;
  plantedAt: string | null;
  captureEnabled: boolean;
};

function tabHref(projectId: string, tab: string) {
  return `/projects/${projectId}?tab=${tab}`;
}

/**
 * Project Overview tab - the landing surface after project creation. Compact,
 * clickable summary cards (status, camera, environment, latest photo) that link
 * into the deeper tabs, plus quick actions. No deep editing here.
 */
export function ProjectOverviewTab({
  project,
  cameraSummary,
  bindings,
  latestPhoto,
  nextCaptureAt,
  insideWindow,
  canCaptureProject,
}: {
  project: OverviewProject;
  cameraSummary: ProjectCameraSummaryView;
  bindings: ProjectSensorBindingView[];
  latestPhoto: { id: string; filename: string; timestamp: string } | null;
  nextCaptureAt: string | null;
  insideWindow: boolean;
  canCaptureProject: boolean;
}) {
  const sensorsWithReadings = bindings.filter((binding) => binding.sensor.latestTemperatureC !== null && binding.sensor.latestHumidityPct !== null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SummaryCard title="Status">
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-stone-950">Scheduled capture</dt>
            <dd>
              <StatusBadge tone={project.captureEnabled ? "ok" : "neutral"}>{project.captureEnabled ? "Enabled" : "Disabled"}</StatusBadge>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Capture window</dt>
            <dd className={insideWindow ? "text-emerald-700" : "text-amber-700"}>{insideWindow ? "Inside window" : "Outside window"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Next capture</dt>
            <dd className="text-stone-600">{nextCaptureAt ? formatDateTimeInZone(nextCaptureAt, project.timeZone) : "None scheduled"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Grid</dt>
            <dd className="text-stone-600">
              {project.gridWidth} × {project.gridHeight}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Planted</dt>
            <dd className="text-stone-600">{project.plantedAt ? formatDateTime(project.plantedAt) : "Unknown"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Timezone</dt>
            <dd className="text-stone-600">{project.timeZone}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {canCaptureProject && !project.isTestProject ? <CapturePhotoButton projectId={project.id} /> : null}
          <Link href={tabHref(project.id, "photos")} className="button-secondary">
            View photos
          </Link>
        </div>
      </SummaryCard>

      <SummaryCard title="Camera" headerRight={<Link href={tabHref(project.id, "camera")} className="text-sm font-semibold text-emerald-700 hover:underline">Configure &rarr;</Link>}>
        {cameraSummary.camera ? (
          <dl className="mt-3 grid gap-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-stone-500">Camera</dt>
              <dd className="font-medium text-stone-900">{cameraSummary.camera.displayName}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-stone-500">Source captures</dt>
              <dd className="text-stone-700">{cameraSummary.source ? `${cameraSummary.source.mode.width}×${cameraSummary.source.mode.height}` : "-"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-stone-500">Project samples</dt>
              <dd className="text-stone-700">
                {cameraSummary.projectSampling.enabled && cameraSummary.projectSampling.intervalMinutes
                  ? `every ${cameraSummary.projectSampling.intervalMinutes} min`
                  : "every source capture"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-stone-500">Latest capture</dt>
              <dd className="text-stone-700">{cameraSummary.latestCapture ? formatDateTime(cameraSummary.latestCapture.capturedAt) : "never"}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-stone-600">No camera selected.</p>
        )}
      </SummaryCard>

      <SummaryCard title="Environment" headerRight={<Link href={tabHref(project.id, "environment")} className="text-sm font-semibold text-emerald-700 hover:underline">View &rarr;</Link>}>
        {bindings.length === 0 ? (
          <p className="mt-3 text-sm text-stone-600">No sensors linked.</p>
        ) : (
          <>
            <p className="mt-3 text-sm text-stone-600">
              {bindings.length} sensor{bindings.length === 1 ? "" : "s"} linked
            </p>
            <ul className="mt-2 grid gap-1 text-sm">
              {sensorsWithReadings.slice(0, 4).map((binding) => (
                <li key={binding.id} className="flex justify-between gap-2">
                  <span className="text-stone-500">{binding.label ?? binding.sensor.name}</span>
                  <span className="text-stone-800">
                    {celsiusToFahrenheit(binding.sensor.latestTemperatureC as number).toFixed(1)}°F / {(binding.sensor.latestHumidityPct as number).toFixed(0)}%
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </SummaryCard>

      <SummaryCard title="Latest photo" headerRight={<Link href={tabHref(project.id, "photos")} className="text-sm font-semibold text-emerald-700 hover:underline">Gallery &rarr;</Link>}>
        {latestPhoto ? (
          <Link href={`/photos/${latestPhoto.id}`} className="mt-3 block">
            <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
              <Image src={`/api/photos/${latestPhoto.id}/file`} alt={latestPhoto.filename} fill sizes="(max-width: 1024px) 100vw, 400px" className="object-contain" />
            </div>
            <p className="mt-2 text-sm text-stone-500">{formatDateTimeInZone(latestPhoto.timestamp, project.timeZone)}</p>
          </Link>
        ) : (
          <p className="mt-3 text-sm text-stone-600">No photos yet.</p>
        )}
      </SummaryCard>
    </div>
  );
}
