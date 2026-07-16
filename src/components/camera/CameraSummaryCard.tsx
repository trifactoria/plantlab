import Link from "next/link";
import type { ReactNode } from "react";
import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";
import { formatAge } from "@/lib/greenhouseDisplay";
import { cameraStatusTone, StatusBadge } from "@/components/shell/StatusBadge";
import { currentModeLabel } from "./cameraFormat";

const STATUS_LABELS: Record<FleetCameraSummary["status"], string> = {
  available: "Available",
  unavailable: "Unavailable",
  disabled: "Disabled",
  retired: "Retired",
  "node-offline": "Node offline",
};

/**
 * Canonical selected-camera context card. Shows the user-owned displayName as
 * the primary identity and the hardware-reported name only as secondary
 * diagnostic text, plus node, availability, and the currently configured mode.
 * Reusable across the shelf-camera page, project Camera tab, Cameras
 * dashboard, and node camera pages via the FleetCameraSummary shape.
 */
export function CameraSummaryCard({
  camera,
  compact = false,
  actions,
}: {
  camera: FleetCameraSummary;
  compact?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-stone-950" data-testid="camera-display-name">
            {camera.displayName}
          </h2>
          {camera.reportedName && camera.reportedName !== camera.displayName ? (
            <p className="mt-0.5 text-xs text-stone-400" data-testid="camera-reported-name">
              Reported by hardware: {camera.reportedName}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-stone-600">
            Node:{" "}
            <Link href={`/nodes/${encodeURIComponent(camera.node.name)}`} className="font-medium text-emerald-700 hover:underline">
              {camera.node.name}
            </Link>
            {camera.node.localToCoordinator ? " (this installation)" : ""}
            {!camera.node.online ? " · offline" : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge tone={cameraStatusTone(camera.status)}>{STATUS_LABELS[camera.status]}</StatusBadge>
          {actions}
        </div>
      </div>

      {!compact ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium text-stone-950">Configured mode</dt>
            <dd className="text-stone-600">{camera.currentMode ? currentModeLabel(camera.currentMode) : "Not set"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Capture source</dt>
            <dd className="text-stone-600">{camera.captureSourceId ? "Assigned" : "Unassigned"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Last capture</dt>
            <dd className="text-stone-600">
              {camera.lastCaptureAt ? `${formatAge(camera.lastCaptureAt)}${camera.lastCaptureStatus ? ` (${camera.lastCaptureStatus})` : ""}` : "never"}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
