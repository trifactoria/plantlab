import type { PlantLabNode } from "@prisma/client";
import { parseCapabilities } from "./operations/capabilities";

export const DEFAULT_SOURCE_CAPTURE_INTERVAL_MINUTES = 15;
export const DEFAULT_GREENHOUSE_CAPTURE_TIME_ZONE = "America/New_York";
export const DEFAULT_GREENHOUSE_CAPTURE_WINDOW_START_MINUTES = 8 * 60;
export const DEFAULT_GREENHOUSE_CAPTURE_WINDOW_END_MINUTES = 0;

export type CaptureSourceScheduleDefaults = {
  photoIntervalMinutes: number;
  timeZone: string;
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
};

export function defaultCaptureSourceScheduleForNode(
  node: Pick<PlantLabNode, "role" | "capabilitiesJson"> | null | undefined,
): CaptureSourceScheduleDefaults {
  const capabilities = node ? parseCapabilities(node.capabilitiesJson) : [];
  const greenhouseLike =
    node?.role === "greenhouse-node" ||
    (capabilities.includes("camera") &&
      capabilities.some((capability) => ["temperature", "humidity", "relay", "fan", "light", "pump"].includes(capability)));

  if (greenhouseLike) {
    return {
      photoIntervalMinutes: DEFAULT_SOURCE_CAPTURE_INTERVAL_MINUTES,
      timeZone: DEFAULT_GREENHOUSE_CAPTURE_TIME_ZONE,
      captureWindowEnabled: true,
      captureWindowStartMinutes: DEFAULT_GREENHOUSE_CAPTURE_WINDOW_START_MINUTES,
      captureWindowEndMinutes: DEFAULT_GREENHOUSE_CAPTURE_WINDOW_END_MINUTES,
    };
  }

  return {
    photoIntervalMinutes: DEFAULT_SOURCE_CAPTURE_INTERVAL_MINUTES,
    timeZone: DEFAULT_GREENHOUSE_CAPTURE_TIME_ZONE,
    captureWindowEnabled: false,
    captureWindowStartMinutes: null,
    captureWindowEndMinutes: null,
  };
}

export function dailyWindowCrossesMidnight(start: number | null, end: number | null) {
  return start !== null && end !== null && start !== end && start > end;
}
