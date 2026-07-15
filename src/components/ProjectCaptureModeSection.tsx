"use client";

import Link from "next/link";
import { CameraSelect } from "@/components/CameraSelect";
import { CaptureSourceSelect } from "@/components/CaptureSourceSelect";

export type ProjectCaptureMode = "none" | "direct-local" | "capture-source";

/**
 * Project settings capture-mode picker: switches between no camera, a
 * direct local V4L2 device (the pre-distributed-CaptureSource behavior,
 * preserved for existing direct-local projects), or a shared distributed
 * CaptureSource. Deliberately controlled by the parent form (mirrors
 * CameraSelect/CaptureScheduleFields's own pattern) rather than owning its
 * own submission state.
 */
export function ProjectCaptureModeSection({
  mode,
  onModeChange,
  cameraDevice,
  cameraName,
  onCameraDeviceChange,
  captureSourceId,
  onCaptureSourceIdChange,
  localControlsEnabled = true,
}: {
  mode: ProjectCaptureMode;
  onModeChange: (mode: ProjectCaptureMode) => void;
  cameraDevice: string;
  cameraName: string | null;
  onCameraDeviceChange: (device: string) => void;
  captureSourceId: string;
  onCaptureSourceIdChange: (captureSourceId: string) => void;
  localControlsEnabled?: boolean;
}) {
  const showDirectLocalMode = localControlsEnabled || mode === "direct-local";

  return (
    <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
      <p className="text-sm font-semibold text-stone-800">Capture mode</p>
      <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Capture mode">
        <label className="flex items-center gap-2">
          <input type="radio" name="projectCaptureMode" checked={mode === "none"} onChange={() => onModeChange("none")} />
          No Camera
        </label>
        {showDirectLocalMode ? (
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="projectCaptureMode"
              checked={mode === "direct-local"}
              disabled={!localControlsEnabled && mode !== "direct-local"}
              onChange={() => onModeChange("direct-local")}
            />
            Direct Local
          </label>
        ) : null}
        <label className="flex items-center gap-2">
          <input type="radio" name="projectCaptureMode" checked={mode === "capture-source"} onChange={() => onModeChange("capture-source")} />
          Capture Source
        </label>
      </div>

      {mode === "direct-local" && localControlsEnabled ? (
        <CameraSelect defaultDevice={cameraDevice} defaultName={cameraName} onDeviceChange={onCameraDeviceChange} />
      ) : null}

      {mode === "direct-local" && !localControlsEnabled ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          This project has a legacy direct-local camera saved
          {cameraDevice ? ` (${cameraName ?? "Camera"} - ${cameraDevice})` : ""}, but this coordinator does not expose local camera hardware.
          Switch to Capture Source to use cameras configured on attached nodes.
        </p>
      ) : null}

      {mode === "capture-source" ? (
        <>
          <CaptureSourceSelect defaultCaptureSourceId={captureSourceId} onChange={onCaptureSourceIdChange} />
          {/* Project.photoIntervalMinutes/captureStartAt/captureWindow* are
              irrelevant while a CaptureSource is active (the scheduler reads
              the CaptureSource's own schedule columns, shared with every
              other project on it) - CaptureScheduleFields is hidden in this
              mode so editing it can never look like it changes the shared
              schedule. */}
          <p className="rounded-md border border-stone-200 bg-white p-3 text-xs text-stone-600">
            Capture schedule controlled by the selected Capture Source.
            {captureSourceId ? (
              <>
                {" "}
                <Link href={`/capture-sources/${captureSourceId}`} className="font-semibold text-emerald-700 hover:text-emerald-900">
                  View Capture Source
                </Link>
              </>
            ) : null}
          </p>
        </>
      ) : null}
    </div>
  );
}
