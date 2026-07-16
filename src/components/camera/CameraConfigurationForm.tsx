"use client";

import { useState } from "react";
import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";
import { minutesToTimeInput, safeTimeInputToMinutes } from "@/lib/timezone";
import { CameraModeSelector } from "./CameraModeSelector";
import { CameraSummaryCard } from "./CameraSummaryCard";
import { CameraTestCaptureAction } from "./CameraTestCaptureAction";
import { modeKey, type SupportedMode } from "./cameraFormat";

export type CameraSourceConfig = {
  captureSourceId: string | null;
  scheduleEnabled: boolean;
  intervalMinutes: number;
  timeZone: string;
  windowEnabled: boolean;
  windowStartMinutes: number | null;
  windowEndMinutes: number | null;
  illuminationOutletId: string | null;
  illuminationPolicy: "unrestricted" | "only-while-on";
};

export type OutletOption = { id: string; key: string; name: string };

const ROTATIONS = [0, 90, 180, 270] as const;

function firstFrameRate(mode: SupportedMode | null): string | null {
  const raw = mode?.frameRates[0];
  if (!raw) return null;
  const numeric = Number.parseFloat(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

/**
 * Canonical, reusable camera configuration body. Edits every setting the
 * PATCH /api/hardware/cameras/:id/configuration contract supports, saves using
 * the stable fleet-camera identity, waits for a real success, then reloads the
 * canonical summary and reports the requested and persisted mode. It never
 * downgrades resolution on its own and preserves schedule/assignment fields the
 * user did not change. Suitable for the shelf-camera page today and the
 * project Camera modal / node camera pages later - it takes only a
 * FleetCameraSummary, the source schedule config, and the node's outlets.
 */
export function CameraConfigurationForm({
  camera: initialCamera,
  source: initialSource,
  outlets,
  onSaved,
}: {
  camera: FleetCameraSummary;
  source: CameraSourceConfig;
  outlets: OutletOption[];
  onSaved?: (camera: FleetCameraSummary) => void;
}) {
  const [camera, setCamera] = useState(initialCamera);

  const [displayName, setDisplayName] = useState(initialCamera.displayName);
  const [enabled, setEnabled] = useState(initialCamera.enabled);
  const [selectedModeKey, setSelectedModeKey] = useState<string | null>(
    initialCamera.currentMode ? modeKey(initialCamera.currentMode) : null,
  );
  const [selectedMode, setSelectedMode] = useState<SupportedMode | null>(
    initialCamera.supportedModes.find((mode) => initialCamera.currentMode && modeKey(mode) === modeKey(initialCamera.currentMode)) ?? null,
  );
  const [rotation, setRotation] = useState(initialCamera.orientation.rotation);
  const [flipHorizontal, setFlipHorizontal] = useState(initialCamera.orientation.flipHorizontal);
  const [flipVertical, setFlipVertical] = useState(initialCamera.orientation.flipVertical);

  const [scheduleEnabled, setScheduleEnabled] = useState(initialSource.scheduleEnabled);
  const [intervalMinutes, setIntervalMinutes] = useState(String(initialSource.intervalMinutes));
  const [timeZone, setTimeZone] = useState(initialSource.timeZone);
  const [windowEnabled, setWindowEnabled] = useState(initialSource.windowEnabled);
  const [windowStart, setWindowStart] = useState(minutesToTimeInput(initialSource.windowStartMinutes ?? 0));
  const [windowEnd, setWindowEnd] = useState(minutesToTimeInput(initialSource.windowEndMinutes ?? 0));
  const [illuminationOutletId, setIlluminationOutletId] = useState(initialSource.illuminationOutletId ?? "");
  const [illuminationPolicy, setIlluminationPolicy] = useState(initialSource.illuminationPolicy);

  // Advanced reliability + unverified fallback.
  const [warmupFrames, setWarmupFrames] = useState(initialCamera.reliability.warmupFrames ?? "");
  const [captureAttempts, setCaptureAttempts] = useState(initialCamera.reliability.captureAttempts ?? "");
  const [serializeOnNode, setSerializeOnNode] = useState(false);
  const [useUnverifiedFallback, setUseUnverifiedFallback] = useState(false);
  const [fallbackWidth, setFallbackWidth] = useState(String(initialCamera.reliability.fallbackMode?.width ?? ""));
  const [fallbackHeight, setFallbackHeight] = useState(String(initialCamera.reliability.fallbackMode?.height ?? ""));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  function applyReloaded(next: FleetCameraSummary) {
    setCamera(next);
    setSelectedModeKey(next.currentMode ? modeKey(next.currentMode) : null);
    setSelectedMode(next.supportedModes.find((mode) => next.currentMode && modeKey(mode) === modeKey(next.currentMode)) ?? null);
    setDisplayName(next.displayName);
    setEnabled(next.enabled);
    setRotation(next.orientation.rotation);
    setFlipHorizontal(next.orientation.flipHorizontal);
    setFlipVertical(next.orientation.flipVertical);
    onSaved?.(next);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedNotice(null);

    // Send a full snapshot of user-visible values. Fields not represented here
    // (e.g. viewport crops) are left untouched by the backend. Resolution is
    // taken from the explicitly selected verified mode or, only if the user
    // opted into the advanced unverified fallback, the manual dimensions.
    const resolutionMode = selectedMode
      ? { width: selectedMode.width, height: selectedMode.height, inputFormat: selectedMode.inputFormat, frameRate: firstFrameRate(selectedMode) }
      : useUnverifiedFallback && fallbackWidth && fallbackHeight
        ? { width: Number(fallbackWidth), height: Number(fallbackHeight), inputFormat: camera.currentMode?.inputFormat ?? "mjpeg", frameRate: camera.currentMode?.frameRate ?? null }
        : null;

    const body: Record<string, unknown> = {
      displayName,
      enabled,
      rotation,
      flipHorizontal,
      flipVertical,
      timeZone,
      dailyWindowEnabled: windowEnabled,
      dailyWindowStartMinutes: windowEnabled ? safeTimeInputToMinutes(windowStart) : null,
      dailyWindowEndMinutes: windowEnabled ? safeTimeInputToMinutes(windowEnd) : null,
      schedule: { enabled: scheduleEnabled, intervalMinutes: Number(intervalMinutes) },
      illumination: { outletId: illuminationOutletId || null, policy: illuminationPolicy },
      serializeOnNode,
    };
    if (resolutionMode) {
      body.resolution = { width: resolutionMode.width, height: resolutionMode.height };
      body.inputFormat = resolutionMode.inputFormat;
      body.frameRate = resolutionMode.frameRate;
    }
    if (warmupFrames !== "") body.warmupFrames = Number(warmupFrames);
    if (captureAttempts !== "") body.captureAttempts = Number(captureAttempts);

    try {
      const res = await fetch(`/api/hardware/cameras/${encodeURIComponent(camera.id)}/configuration`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof payload.error === "string" ? payload.error : "Could not save camera configuration.");
        return;
      }
      // Reload the canonical summary before claiming success.
      const reloadRes = await fetch(`/api/hardware/cameras/${encodeURIComponent(camera.id)}`, { cache: "no-store" });
      if (reloadRes.ok) {
        const next = (await reloadRes.json()).camera as FleetCameraSummary;
        applyReloaded(next);
        const requested = resolutionMode ? `${resolutionMode.width}×${resolutionMode.height}` : "unchanged";
        const persisted = next.currentMode ? `${next.currentMode.width}×${next.currentMode.height}` : "unset";
        setSavedNotice(`Saved. Requested ${requested}; persisted ${persisted}.`);
      } else {
        setSavedNotice("Saved.");
      }
    } catch {
      setError("Could not reach the coordinator.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <CameraSummaryCard camera={camera} />

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-semibold text-stone-950">Camera configuration</h3>
        <p className="mt-1 text-xs text-stone-500">
          Shared camera/source settings - affect every project using this camera. Executes on {camera.node.name}.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="field sm:col-span-2">
            Display name
            <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} data-testid="camera-display-name-input" />
          </label>

          <div className="sm:col-span-2">
            <CameraModeSelector
              camera={camera}
              supportedModes={camera.supportedModes}
              selectedKey={selectedModeKey}
              onSelect={(mode) => {
                setSelectedMode(mode);
                setSelectedModeKey(modeKey(mode));
              }}
              onRefreshed={applyReloaded}
            />
          </div>

          <label className="field">
            Rotation
            <select className="input" value={rotation} onChange={(event) => setRotation(Number(event.target.value) as 0 | 90 | 180 | 270)}>
              {ROTATIONS.map((value) => (
                <option key={value} value={value}>
                  {value}°
                </option>
              ))}
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

        <div className="mt-5 grid gap-4 rounded-md border border-stone-200 bg-stone-50 p-3">
          <p className="text-sm font-semibold text-stone-800">Source schedule</p>
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} />
            Scheduled capture enabled
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="field">
              Source cadence (minutes)
              <input className="input" type="number" min="1" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} />
            </label>
            <label className="field">
              Timezone
              <input className="input" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} />
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm text-stone-700">
              <input type="checkbox" checked={windowEnabled} onChange={(event) => setWindowEnabled(event.target.checked)} />
              Limit to a daily window
            </label>
          </div>
          {windowEnabled ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">
                Active from
                <input className="input" type="time" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
              </label>
              <label className="field">
                Active until (00:00 = end of day)
                <input className="input" type="time" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
              </label>
            </div>
          ) : null}
          <p className="text-xs text-stone-500">This is the shared source cadence, not a project&apos;s sampling interval.</p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="field">
            Illumination outlet
            <select className="input" value={illuminationOutletId} onChange={(event) => setIlluminationOutletId(event.target.value)}>
              <option value="">None</option>
              {outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Illumination policy
            <select
              className="input"
              value={illuminationPolicy}
              onChange={(event) => setIlluminationPolicy(event.target.value as "unrestricted" | "only-while-on")}
            >
              <option value="unrestricted">Capture regardless of outlet</option>
              <option value="only-while-on">Only capture while outlet is on</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-stone-700 sm:col-span-2">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Camera enabled
          </label>
        </div>

        <details className="mt-5 rounded-md border border-stone-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-stone-800">Advanced / Troubleshooting</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="field">
              Warm-up frames
              <input className="input" type="number" min="0" value={warmupFrames} onChange={(event) => setWarmupFrames(event.target.value)} />
            </label>
            <label className="field">
              Primary capture attempts
              <input className="input" type="number" min="1" value={captureAttempts} onChange={(event) => setCaptureAttempts(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-700 sm:col-span-2">
              <input type="checkbox" checked={serializeOnNode} onChange={(event) => setSerializeOnNode(event.target.checked)} />
              Serialize captures on the node
            </label>
            <div className="sm:col-span-2 grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-amber-900">
                <input type="checkbox" checked={useUnverifiedFallback} onChange={(event) => setUseUnverifiedFallback(event.target.checked)} />
                Use an unverified capture mode (not a verified camera mode)
              </label>
              {useUnverifiedFallback ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="field">
                    Width
                    <input className="input" type="number" value={fallbackWidth} onChange={(event) => setFallbackWidth(event.target.value)} />
                  </label>
                  <label className="field">
                    Height
                    <input className="input" type="number" value={fallbackHeight} onChange={(event) => setFallbackHeight(event.target.value)} />
                  </label>
                </div>
              ) : null}
            </div>
          </div>
        </details>

        {error ? <p className="mt-4 text-sm font-medium text-red-700">{error}</p> : null}
        {savedNotice ? <p className="mt-4 text-sm font-medium text-emerald-700" data-testid="camera-save-notice">{savedNotice}</p> : null}
        <button type="button" className="button mt-4" onClick={save} disabled={saving} data-testid="camera-save">
          {saving ? "Saving..." : "Save camera configuration"}
        </button>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-semibold text-stone-950">Test capture</h3>
        <p className="mt-1 text-xs text-stone-500">Runs on {camera.node.name} and reports the requested vs effective mode with a validated preview.</p>
        <div className="mt-3">
          <CameraTestCaptureAction camera={camera} />
        </div>
      </div>
    </div>
  );
}
