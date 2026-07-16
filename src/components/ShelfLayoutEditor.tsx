"use client";

import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CaptureScheduleFields,
  captureSchedulePayload,
  initialScheduleValue,
  type CaptureScheduleValue,
} from "@/components/CaptureScheduleFields";
import { flattenCameraModes, formatLabel, normalizeCameraInputFormat, preferredCameraMode, type CameraMode } from "@/lib/cameraModes";
import { isValidRotation, transformedDimensions, type Rotation } from "@/lib/orientation";
import { findOverlappingPairs, pixelDimensionsForRect, type NormalizedRect } from "@/lib/viewportGeometry";
import { formatDateTime } from "@/lib/format";

type CameraFormat = {
  pixelFormat: string;
  description: string;
  resolutions: Array<{ width: number; height: number; frameRates: string[] }>;
};

type Viewport = {
  id: string;
  projectId: string;
  project: { id: string; name: string };
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  active: boolean;
  effectiveFrom: string;
};

type FanOutProjectResult = {
  projectId: string;
  projectName: string;
  status: "success" | "failed";
  photoId?: string;
  derivedWidth?: number;
  derivedHeight?: number;
  errorMessage?: string;
};

type SourceProps = {
  id: string;
  name: string;
  cameraDevice: string;
  cameraName: string | null;
  cameraStableId: string | null;
  width: number;
  height: number;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  active: boolean;
  inputFormat: string;
  rawWidth: number | null;
  rawHeight: number | null;
  photoIntervalMinutes: number;
  captureStartAt: string;
  timeZone: string;
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
};

export function ShelfLayoutEditor({
  source,
  projects,
  hideCameraConfig = false,
}: {
  source: SourceProps;
  projects: Array<{ id: string; name: string; isTestProject: boolean }>;
  /** When the canonical camera-configuration UI owns capture mode/orientation/schedule (e.g. a remote node camera), hide this editor's own capability/orientation card and keep only the shelf-layout crop editor. */
  hideCameraConfig?: boolean;
}) {
  const router = useRouter();
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const [formats, setFormats] = useState<CameraFormat[]>([]);
  const [formatsLoaded, setFormatsLoaded] = useState(false);
  const [formatRefreshMessage, setFormatRefreshMessage] = useState<string | null>(null);
  const [formatRefreshError, setFormatRefreshError] = useState<string | null>(null);
  const [refreshingInventory, setRefreshingInventory] = useState(false);
  const [allowUnverifiedFallback, setAllowUnverifiedFallback] = useState(false);
  const sourceInputFormat = normalizeCameraInputFormat(source.inputFormat);
  const sourceRaw = transformedDimensions(source.width, source.height, isValidRotation(source.rotation) ? source.rotation : 0);
  const initialRawWidth = source.rawWidth ?? sourceRaw.width;
  const initialRawHeight = source.rawHeight ?? sourceRaw.height;
  const [selectedModeKey, setSelectedModeKey] = useState(`${sourceInputFormat}:${initialRawWidth}x${initialRawHeight}`);
  const [rotation, setRotation] = useState<Rotation>(isValidRotation(source.rotation) ? source.rotation : 0);
  const [flipHorizontal, setFlipHorizontal] = useState(source.flipHorizontal);
  const [flipVertical, setFlipVertical] = useState(source.flipVertical);
  const [active, setActive] = useState(source.active);
  const [schedule, setSchedule] = useState<CaptureScheduleValue>(() =>
    initialScheduleValue({
      timeZone: source.timeZone,
      photoIntervalMinutes: source.photoIntervalMinutes,
      captureStartAt: source.captureStartAt,
      captureWindowEnabled: source.captureWindowEnabled,
      captureWindowStartMinutes: source.captureWindowStartMinutes,
      captureWindowEndMinutes: source.captureWindowEndMinutes,
    }),
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [capturingFrame, setCapturingFrame] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameImage, setFrameImage] = useState<string | null>(null);
  const [frameWorkingSize, setFrameWorkingSize] = useState<{ width: number; height: number } | null>(null);
  const [frameSourceCaptureId, setFrameSourceCaptureId] = useState<string | null>(null);

  const [viewports, setViewports] = useState<Viewport[]>([]);
  const [overlappingIds, setOverlappingIds] = useState<string[]>([]);
  const [draftRect, setDraftRect] = useState<NormalizedRect | null>(null);
  const [assignProjectId, setAssignProjectId] = useState("");
  const [savingViewport, setSavingViewport] = useState(false);
  const [viewportError, setViewportError] = useState<string | null>(null);

  const [testCapturing, setTestCapturing] = useState(false);
  const [testCaptureError, setTestCaptureError] = useState<string | null>(null);
  const [testCaptureResults, setTestCaptureResults] = useState<FanOutProjectResult[] | null>(null);

  const modes = flattenCameraModes(formats);
  const [selectedFormat, selectedResolution = ""] = selectedModeKey.split(":");
  const [selectedRawWidth, selectedRawHeight] = selectedResolution.split("x").map(Number);
  const selectedMode = modes.find((mode) => modeKey(mode) === selectedModeKey) ?? null;
  const preferredMode = preferredCameraMode(formats);
  const sourceModeKey = `${sourceInputFormat}:${initialRawWidth}x${initialRawHeight}`;
  const repairMode = preferredMode && modeKey(preferredMode) !== sourceModeKey ? preferredMode : null;
  const assignableProjects = projects.filter((project) => !project.isTestProject);

  function modeKey(mode: Pick<CameraMode, "inputFormat" | "width" | "height">) {
    return `${mode.inputFormat}:${mode.width}x${mode.height}`;
  }

  function modeLabel(mode: CameraMode) {
    const fps = mode.frameRates.length > 0 ? ` - ${mode.frameRates.join(", ")}` : "";
    return `${formatLabel(mode.inputFormat)} - ${mode.width}x${mode.height}${fps}`;
  }

  async function loadFormats() {
    setFormatsLoaded(false);
    const response = await fetch(`/api/capture-sources/${source.id}/formats`);
    const payload = (await response.json()) as { formats?: CameraFormat[] };
    const nextFormats = payload.formats ?? [];
    setFormats(nextFormats);
    setFormatsLoaded(true);
    const nextModes = flattenCameraModes(nextFormats);
    const saved = nextModes.find(
      (mode) => mode.inputFormat === sourceInputFormat && mode.width === initialRawWidth && mode.height === initialRawHeight,
    );
    const fallback = saved ?? preferredCameraMode(nextFormats) ?? nextModes[0];
    if (fallback) {
      setSelectedModeKey(modeKey(fallback));
    }
  }

  async function refreshInventory() {
    setRefreshingInventory(true);
    setFormatRefreshMessage(null);
    setFormatRefreshError(null);
    try {
      const response = await fetch(`/api/capture-sources/${source.id}/inventory-refresh`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Could not request camera inventory refresh.");
      }
      setFormatRefreshMessage(`Refresh requested from ${payload.nodeName}. Reloading capability data shortly.`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await loadFormats();
    } catch (error) {
      setFormatRefreshError(error instanceof Error ? error.message : "Could not request camera inventory refresh.");
    } finally {
      setRefreshingInventory(false);
    }
  }

  async function loadViewports() {
    const response = await fetch(`/api/capture-sources/${source.id}/viewports`);
    const payload = (await response.json()) as { viewports?: Viewport[]; overlappingViewportIds?: string[] };
    setViewports(payload.viewports ?? []);
    setOverlappingIds(payload.overlappingViewportIds ?? []);
  }

  useEffect(() => {
    void loadFormats();
    void loadViewports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id]);

  async function saveSettings(modeOverride?: CameraMode) {
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsMessage(null);

    const rawWidth = modeOverride?.width ?? selectedRawWidth;
    const rawHeight = modeOverride?.height ?? selectedRawHeight;
    const inputFormat = modeOverride?.inputFormat ?? selectedFormat;
    const working = transformedDimensions(rawWidth || source.width, rawHeight || source.height, rotation);

    const response = await fetch(`/api/capture-sources/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        width: working.width,
        height: working.height,
        assignmentWidth: rawWidth,
        assignmentHeight: rawHeight,
        inputFormat,
        rotation,
        flipHorizontal,
        flipVertical,
        active,
        ...captureSchedulePayload(schedule),
      }),
    });
    const payload = await response.json();
    setSavingSettings(false);

    if (!response.ok) {
      setSettingsError(payload.error ?? "Could not save shelf camera settings.");
      return;
    }

    if (modeOverride) setSelectedModeKey(modeKey(modeOverride));
    setSettingsMessage(`Saved. Working frame is now ${working.width} x ${working.height}.`);
    router.refresh();
  }

  async function captureTestFrame() {
    setCapturingFrame(true);
    setFrameError(null);

    try {
      const response = await fetch(`/api/capture-sources/${source.id}/test-frame`, { method: "POST" });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Could not capture test frame.");
      }

      setFrameImage(`data:image/jpeg;base64,${payload.imageBase64}`);
      setFrameWorkingSize({ width: payload.workingWidth, height: payload.workingHeight });
      setFrameSourceCaptureId(payload.sourceCapture?.id ?? null);
    } catch (error) {
      setFrameError(error instanceof Error ? error.message : "Could not capture test frame.");
    } finally {
      setCapturingFrame(false);
    }
  }

  function pointFromEvent(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!frameImage) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (!point) return;
    dragRef.current = point;
    setDraftRect({ cropX: point.x, cropY: point.y, cropWidth: 0, cropHeight: 0 });
    setAssignProjectId("");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (!start) return;
    const point = pointFromEvent(event);
    if (!point) return;

    const cropX = Math.min(start.x, point.x);
    const cropY = Math.min(start.y, point.y);
    const cropWidth = Math.abs(point.x - start.x);
    const cropHeight = Math.abs(point.y - start.y);
    setDraftRect({ cropX, cropY, cropWidth, cropHeight });
  }

  function handlePointerUp() {
    dragRef.current = null;
    setDraftRect((current) => {
      if (current && (current.cropWidth < 0.01 || current.cropHeight < 0.01)) {
        return null;
      }
      return current;
    });
  }

  async function saveDraftViewport() {
    if (!draftRect || !assignProjectId) return;

    setSavingViewport(true);
    setViewportError(null);

    try {
      const response = await fetch(`/api/capture-sources/${source.id}/viewports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: assignProjectId,
          ...draftRect,
          sourceCaptureId: frameSourceCaptureId,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Could not save this project area.");
      }

      setDraftRect(null);
      setAssignProjectId("");
      await loadViewports();
    } catch (error) {
      setViewportError(error instanceof Error ? error.message : "Could not save this project area.");
    } finally {
      setSavingViewport(false);
    }
  }

  async function deactivateViewport(viewportId: string) {
    await fetch(`/api/viewports/${viewportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    await loadViewports();
  }

  async function triggerTestCapture() {
    setTestCapturing(true);
    setTestCaptureError(null);
    setTestCaptureResults(null);

    try {
      const response = await fetch(`/api/capture-sources/${source.id}/test-capture`, { method: "POST" });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Test fan-out capture failed.");
      }

      setTestCaptureResults(payload.fanOut?.projectResults ?? []);
      router.refresh();
    } catch (error) {
      setTestCaptureError(error instanceof Error ? error.message : "Test fan-out capture failed.");
    } finally {
      setTestCapturing(false);
    }
  }

  const frameSize = frameWorkingSize ?? { width: source.width, height: source.height };
  const overlapWarning = findOverlappingPairs(viewports).length > 0;
  const capabilityDataMissing = formatsLoaded && modes.length === 0;
  const canSaveMode = modes.length > 0 || allowUnverifiedFallback;

  return (
    <div className="grid gap-6">
      {hideCameraConfig ? null : (
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Capability and Orientation</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="field sm:col-span-2">
            Capture mode
            <select
              className="input"
              data-testid="raw-resolution-select"
              value={selectedModeKey}
              onChange={(event) => setSelectedModeKey(event.target.value)}
              disabled={capabilityDataMissing && !allowUnverifiedFallback}
            >
              {modes.length === 0 && allowUnverifiedFallback ? (
                <option value={selectedModeKey}>
                  Unverified fallback - {formatLabel(selectedFormat)} - {selectedRawWidth || source.width}x{selectedRawHeight || source.height}
                </option>
              ) : modes.length === 0 ? (
                <option value={selectedModeKey}>Capability data unavailable</option>
              ) : (
                modes.map((mode) => (
                  <option key={modeKey(mode)} value={modeKey(mode)}>
                    {modeLabel(mode)}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="field">
            Rotation
            <select
              className="input"
              data-testid="rotation-select"
              value={rotation}
              onChange={(event) => setRotation(Number(event.target.value) as Rotation)}
            >
              <option value={0}>0°</option>
              <option value={90}>90°</option>
              <option value={180}>180°</option>
              <option value={270}>270°</option>
            </select>
          </label>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={flipHorizontal} onChange={(event) => setFlipHorizontal(event.target.checked)} />
              Flip horizontal
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={flipVertical} onChange={(event) => setFlipVertical(event.target.checked)} />
              Flip vertical
            </label>
          </div>
        </div>
        <p className="mt-3 text-sm text-stone-600" data-testid="transformed-dimensions">
          {(() => {
            const rawWidth = selectedMode?.width ?? selectedRawWidth;
            const rawHeight = selectedMode?.height ?? selectedRawHeight;
            const working = transformedDimensions(rawWidth || source.width, rawHeight || source.height, rotation);
            return `Transformed working frame: ${working.width} x ${working.height}`;
          })()}
        </p>
        {capabilityDataMissing ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="missing-capability-warning">
            <p className="font-medium">Camera capability data is unavailable.</p>
            <p className="mt-1">Refresh camera inventory before selecting a verified capture mode.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="button-secondary" onClick={refreshInventory} disabled={refreshingInventory}>
                {refreshingInventory ? "Refreshing..." : "Refresh Inventory"}
              </button>
              <button type="button" className="button-secondary" onClick={() => setAllowUnverifiedFallback(true)}>
                Use Unverified Fallback
              </button>
            </div>
            {formatRefreshMessage ? <p className="mt-2 text-emerald-800">{formatRefreshMessage}</p> : null}
            {formatRefreshError ? <p className="mt-2 font-medium text-red-700">{formatRefreshError}</p> : null}
          </div>
        ) : null}
        {repairMode ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="preferred-mode-repair">
            <p>
              Preferred verified mode is available: {modeLabel(repairMode)}. Current saved mode is{" "}
              {formatLabel(sourceInputFormat)} - {initialRawWidth}x{initialRawHeight}.
            </p>
            <button type="button" className="button-secondary mt-2" onClick={() => saveSettings(repairMode)} disabled={savingSettings}>
              Use Preferred Mode
            </button>
          </div>
        ) : null}

        <label className="mt-4 flex items-center gap-2 text-sm font-medium text-stone-800">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          Active (eligible for scheduled capture)
        </label>

        <div className="mt-4">
          <CaptureScheduleFields value={schedule} onChange={(patch) => setSchedule((current) => ({ ...current, ...patch }))} />
        </div>
        <p className="mt-3 text-sm font-medium text-amber-800">
          Projects using this shelf camera share its capture schedule.
        </p>

        {settingsError ? <p className="mt-3 text-sm font-medium text-red-700">{settingsError}</p> : null}
        {settingsMessage ? <p className="mt-3 text-sm font-medium text-emerald-700">{settingsMessage}</p> : null}
        <button type="button" className="button mt-4" onClick={() => saveSettings()} disabled={savingSettings || !canSaveMode}>
          {savingSettings ? "Saving..." : "Save Shelf Camera Settings"}
        </button>
      </div>
      )}

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-stone-950">Shelf Layout</h2>
          <button type="button" className="button-secondary" onClick={captureTestFrame} disabled={capturingFrame}>
            {capturingFrame ? "Capturing..." : "Capture Test Frame"}
          </button>
        </div>
        {frameError ? <p className="mt-3 text-sm font-medium text-red-700">{frameError}</p> : null}

        {overlapWarning ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="overlap-warning">
            Two or more project areas overlap. Overlapping areas are allowed, but double-check this is intentional.
          </p>
        ) : null}

        {frameImage ? (
          <div className="mt-4 grid gap-3">
            <div
              ref={stageRef}
              data-testid="shelf-layout-stage"
              className="relative w-full cursor-crosshair overflow-hidden rounded-md bg-black"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={frameImage} alt="Shelf test frame" draggable={false} className="block w-full select-none" />

              {viewports.map((viewport) => {
                const px = pixelDimensionsForRect(viewport, frameSize.width, frameSize.height);
                const overlapping = overlappingIds.includes(viewport.id);
                return (
                  <div
                    key={viewport.id}
                    data-testid={`viewport-region-${viewport.id}`}
                    className={`absolute border-2 ${overlapping ? "border-amber-400 bg-amber-400/20" : "border-emerald-400 bg-emerald-400/20"}`}
                    style={{
                      left: `${viewport.cropX * 100}%`,
                      top: `${viewport.cropY * 100}%`,
                      width: `${viewport.cropWidth * 100}%`,
                      height: `${viewport.cropHeight * 100}%`,
                    }}
                  >
                    <span className="absolute left-0 top-0 rounded-br bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                      {viewport.project.name} - {px.width}x{px.height}
                    </span>
                  </div>
                );
              })}

              {draftRect ? (
                <div
                  className="absolute border-2 border-cyan-300 bg-cyan-300/20"
                  style={{
                    left: `${draftRect.cropX * 100}%`,
                    top: `${draftRect.cropY * 100}%`,
                    width: `${draftRect.cropWidth * 100}%`,
                    height: `${draftRect.cropHeight * 100}%`,
                  }}
                />
              ) : null}
            </div>

            {draftRect ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
                <label className="field">
                  Assign to project
                  <select className="input" value={assignProjectId} onChange={(event) => setAssignProjectId(event.target.value)}>
                    <option value="">Choose a project</option>
                    {assignableProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="text-sm text-stone-600">
                  Output: {pixelDimensionsForRect(draftRect, frameSize.width, frameSize.height).width} x{" "}
                  {pixelDimensionsForRect(draftRect, frameSize.width, frameSize.height).height}
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={saveDraftViewport}
                  disabled={savingViewport || !assignProjectId}
                >
                  {savingViewport ? "Saving..." : "Use this project area from this frame forward"}
                </button>
                <button type="button" className="button-secondary" onClick={() => setDraftRect(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <p className="text-sm text-stone-500">Drag on the frame above to draw a new project area.</p>
            )}
            {viewportError ? <p className="text-sm font-medium text-red-700">{viewportError}</p> : null}
          </div>
        ) : (
          <p className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">
            Capture a test frame to draw project areas.
          </p>
        )}

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-stone-800">Active project areas</h3>
          {viewports.length === 0 ? (
            <p className="mt-2 text-sm text-stone-600">No project areas assigned yet.</p>
          ) : (
            <ul className="mt-2 grid gap-2">
              {viewports.map((viewport) => {
                const px = pixelDimensionsForRect(viewport, frameSize.width, frameSize.height);
                return (
                  <li
                    key={viewport.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm"
                  >
                    <span>
                      <strong className="text-stone-900">{viewport.project.name}</strong> - {px.width}x{px.height} px -
                      effective {formatDateTime(new Date(viewport.effectiveFrom))}
                    </span>
                    <button type="button" className="button-secondary" onClick={() => deactivateViewport(viewport.id)}>
                      Deactivate
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-stone-950">Test Fan-Out Capture</h2>
          <button type="button" className="button" onClick={triggerTestCapture} disabled={testCapturing}>
            {testCapturing ? "Capturing..." : "Trigger Test Capture"}
          </button>
        </div>
        <p className="mt-2 text-sm text-stone-600">
          Captures the shelf once and generates one derived photo per active project area, exactly
          like a scheduled capture.
        </p>
        {testCaptureError ? <p className="mt-3 text-sm font-medium text-red-700">{testCaptureError}</p> : null}
        {testCaptureResults ? (
          <ul className="mt-3 grid gap-2" data-testid="test-capture-results">
            {testCaptureResults.map((result) => (
              <li
                key={result.projectId}
                className={`rounded-md border p-3 text-sm ${
                  result.status === "success" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
                }`}
              >
                <strong>{result.projectName}</strong>:{" "}
                {result.status === "success"
                  ? `Photo created (${result.derivedWidth}x${result.derivedHeight})`
                  : `Failed - ${result.errorMessage}`}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
