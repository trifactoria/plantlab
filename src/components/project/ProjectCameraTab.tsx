"use client";

import Link from "next/link";
import { useState } from "react";
import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";
import { CameraConfigurationForm, type CameraSourceConfig, type OutletOption } from "@/components/camera/CameraConfigurationForm";
import { CameraInventoryRefreshAction } from "@/components/camera/CameraInventoryRefreshAction";
import { CameraScheduleSummary } from "@/components/camera/CameraScheduleSummary";
import { CameraTestCaptureAction } from "@/components/camera/CameraTestCaptureAction";
import { Drawer } from "@/components/shell/Drawer";
import { EmptyState, SummaryCard } from "@/components/shell/SummaryCard";
import { StatusBadge } from "@/components/shell/StatusBadge";
import { formatDateTime } from "@/lib/format";

export type ProjectCameraSummaryView = {
  mode: "none" | "direct-local" | "capture-source";
  camera: { displayName: string; reportedName: string | null; nodeName: string; available: boolean } | null;
  source: {
    name: string;
    enabled: boolean;
    cadence: { nextCaptureAt: string | null };
    illumination: { policy: "unrestricted" | "only-while-on"; outletLabel: string | null; observedState: boolean | null };
    mode: { width: number; height: number; inputFormat: string; frameRate: string | null };
  } | null;
  projectSampling: { enabled: boolean; intervalMinutes: number | null; nextSampleAt: string | null; lastSampleAt: string | null; missingRecentSampleCount: number };
  latestCapture: { capturedAt: string; projectPhotoId: string | null } | null;
};

/**
 * Project Camera tab: the whole camera experience for a project without page
 * hopping. Shows the current camera/source/resolution/cadence/illumination/
 * schedule/latest capture, and edits happen in a Configure modal that reuses
 * the canonical CameraConfigurationForm (mode, schedule, test, refresh). The
 * only navigation-away action is the advanced Shelf Layout page.
 */
export function ProjectCameraTab({
  summary,
  fleetCamera,
  sourceConfig,
  outlets,
  shelfLayoutUrl,
  settingsHref,
}: {
  summary: ProjectCameraSummaryView;
  fleetCamera: FleetCameraSummary | null;
  sourceConfig: CameraSourceConfig | null;
  outlets: OutletOption[];
  shelfLayoutUrl: string | null;
  settingsHref: string;
}) {
  const [configuring, setConfiguring] = useState(false);

  if (summary.mode === "none" || !summary.camera) {
    return (
      <EmptyState
        message="This project has no camera selected. Choose a shelf camera or a direct-local camera in Settings to start capturing."
        action={{ label: "Choose a camera in Settings", href: settingsHref }}
      />
    );
  }

  const { camera, source } = summary;

  return (
    <div className="grid gap-4">
      <SummaryCard
        title={camera.displayName}
        headerRight={<StatusBadge tone={camera.available ? "ok" : "warn"}>{camera.available ? "Available" : "Unavailable"}</StatusBadge>}
      >
        {camera.reportedName && camera.reportedName !== camera.displayName ? (
          <p className="text-xs text-stone-400">Reported by hardware: {camera.reportedName}</p>
        ) : null}
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="font-medium text-stone-950">Node</dt>
            <dd className="text-stone-600">{camera.nodeName}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Capture source</dt>
            <dd className="text-stone-600">{source?.name ?? "-"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Resolution</dt>
            <dd className="text-stone-600">{source ? `${source.mode.width} × ${source.mode.height} · ${source.mode.inputFormat.toUpperCase()}` : "-"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Illumination</dt>
            <dd className="text-stone-600">
              {source?.illumination.policy === "only-while-on"
                ? `Only while ${source.illumination.outletLabel ?? "outlet"} on`
                : "Unrestricted"}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Latest capture</dt>
            <dd className="text-stone-600">{summary.latestCapture ? formatDateTime(summary.latestCapture.capturedAt) : "never"}</dd>
          </div>
        </dl>

        {source && sourceConfig ? (
          <div className="mt-4 border-t border-stone-100 pt-4">
            <p className="mb-2 text-sm font-semibold text-stone-800">Source schedule</p>
            <CameraScheduleSummary
              intervalMinutes={sourceConfig.intervalMinutes}
              timeZone={sourceConfig.timeZone}
              windowEnabled={sourceConfig.windowEnabled}
              windowStartMinutes={sourceConfig.windowStartMinutes}
              windowEndMinutes={sourceConfig.windowEndMinutes}
              nextCaptureAt={source.cadence.nextCaptureAt}
              enabled={source.enabled}
            />
            <p className="mt-3 text-sm text-stone-600">
              This project samples{" "}
              <span className="font-medium text-stone-900">
                {summary.projectSampling.enabled && summary.projectSampling.intervalMinutes
                  ? `every ${summary.projectSampling.intervalMinutes} minutes`
                  : "on every source capture"}
              </span>{" "}
              from the shared source cadence above.
            </p>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {fleetCamera && sourceConfig ? (
            <button type="button" className="button" onClick={() => setConfiguring(true)} data-testid="project-configure-camera">
              Configure Camera
            </button>
          ) : (
            <Link href={settingsHref} className="button-secondary">
              Configure in Settings
            </Link>
          )}
          {shelfLayoutUrl ? (
            <Link href={shelfLayoutUrl} className="button-secondary">
              View Shelf Layout
            </Link>
          ) : null}
        </div>
      </SummaryCard>

      {fleetCamera ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SummaryCard title="Test capture">
            <div className="mt-3">
              <CameraTestCaptureAction camera={fleetCamera} />
            </div>
          </SummaryCard>
          <SummaryCard title="Camera inventory">
            <p className="mt-2 text-sm text-stone-600">Reload the supported modes reported by {fleetCamera.node.name}.</p>
            <div className="mt-3">
              <CameraInventoryRefreshAction camera={fleetCamera} onRefreshed={() => undefined} />
            </div>
          </SummaryCard>
        </div>
      ) : null}

      {fleetCamera && sourceConfig ? (
        <Drawer open={configuring} onClose={() => setConfiguring(false)} title={`Configure ${fleetCamera.displayName}`} widthClassName="max-w-2xl">
          <CameraConfigurationForm camera={fleetCamera} source={sourceConfig} outlets={outlets} />
        </Drawer>
      ) : null}
    </div>
  );
}
