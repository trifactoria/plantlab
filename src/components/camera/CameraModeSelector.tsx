"use client";

import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";
import { CameraInventoryRefreshAction } from "./CameraInventoryRefreshAction";
import { modeKey, modeLabel, type SupportedMode } from "./cameraFormat";

/**
 * Verified capture-mode picker. Shows the real supported modes reported by the
 * owning node (never fabricated). When capability data is missing it explains
 * which node owns the camera and routes an inventory refresh to that node
 * instead of falling back to an unverified mode as the normal path - the
 * unverified fallback lives in the form's Advanced/Troubleshooting section.
 */
export function CameraModeSelector({
  camera,
  supportedModes,
  selectedKey,
  onSelect,
  onRefreshed,
}: {
  camera: FleetCameraSummary;
  supportedModes: SupportedMode[];
  selectedKey: string | null;
  onSelect: (mode: SupportedMode) => void;
  onRefreshed: (camera: FleetCameraSummary) => void;
}) {
  if (supportedModes.length === 0) {
    return (
      <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="camera-capability-missing">
        <p className="font-medium">Supported capture modes for {camera.displayName} are not available yet.</p>
        <p>
          Capability data is reported by <span className="font-medium">{camera.node.name}</span>. Refresh its camera inventory to load the real
          verified modes.
        </p>
        <CameraInventoryRefreshAction camera={camera} onRefreshed={onRefreshed} />
        <p className="text-xs text-amber-700">
          If the node cannot report modes, an unverified fallback is available under Advanced below - it is not a verified camera mode.
        </p>
      </div>
    );
  }

  return (
    <label className="field">
      Capture mode
      <select
        className="input"
        data-testid="camera-mode-select"
        value={selectedKey ?? ""}
        onChange={(event) => {
          const mode = supportedModes.find((candidate) => modeKey(candidate) === event.target.value);
          if (mode) onSelect(mode);
        }}
      >
        {selectedKey && !supportedModes.some((mode) => modeKey(mode) === selectedKey) ? (
          <option value={selectedKey}>Current configured mode (not in reported list)</option>
        ) : null}
        {supportedModes.map((mode) => (
          <option key={modeKey(mode)} value={modeKey(mode)}>
            {modeLabel(mode)}
          </option>
        ))}
      </select>
    </label>
  );
}
