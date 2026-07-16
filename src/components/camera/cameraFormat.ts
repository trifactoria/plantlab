import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";

export type SupportedMode = FleetCameraSummary["supportedModes"][number];
export type CurrentMode = NonNullable<FleetCameraSummary["currentMode"]>;

/** Stable key for a supported mode option: "mjpeg:1920x1080". Frame rate is chosen separately. */
export function modeKey(mode: { width: number; height: number; inputFormat: string }): string {
  return `${mode.inputFormat}:${mode.width}x${mode.height}`;
}

function prettyFormat(inputFormat: string): string {
  const upper = inputFormat.toUpperCase();
  if (upper === "MJPEG" || upper === "MJPG") return "MJPEG";
  if (upper === "YUYV422" || upper === "YUYV") return "YUYV";
  return upper;
}

/** First frame rate as a compact integer where possible, e.g. "30.000 fps" -> "30 fps". */
function prettyFrameRate(frameRates: string[]): string | null {
  const first = frameRates[0];
  if (!first) return null;
  const numeric = Number.parseFloat(first);
  if (Number.isFinite(numeric)) return `${Number.isInteger(numeric) ? numeric : numeric.toFixed(1)} fps`;
  return first;
}

/** "1920 × 1080 · MJPEG · 30 fps" */
export function modeLabel(mode: SupportedMode): string {
  const fps = prettyFrameRate(mode.frameRates);
  return `${mode.width} × ${mode.height} · ${prettyFormat(mode.inputFormat)}${fps ? ` · ${fps}` : ""}`;
}

/** "1280 × 720 · MJPEG · 30 fps" for the currently configured mode. */
export function currentModeLabel(mode: CurrentMode): string {
  const fps = mode.frameRate ? `${Number.parseFloat(mode.frameRate) || mode.frameRate} fps` : null;
  return `${mode.width} × ${mode.height} · ${prettyFormat(mode.inputFormat)}${fps ? ` · ${fps}` : ""}`;
}

/**
 * Formats an active-window minute-of-day. Midnight (0) is rendered as
 * "12:00 AM" and, as an end boundary, means the exclusive end of the
 * operating day rather than the start.
 */
export function formatMinuteOfDay(minutes: number | null | undefined): string {
  const value = ((minutes ?? 0) % 1440 + 1440) % 1440;
  const hours24 = Math.floor(value / 60);
  const mins = value % 60;
  const period = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(mins).padStart(2, "0")} ${period}`;
}
