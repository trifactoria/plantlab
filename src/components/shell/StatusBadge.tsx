import type { ReactNode } from "react";

/**
 * Shared status vocabulary for the whole app. Domain statuses (node status,
 * camera status, sensor health) map onto one of four visual tones so every
 * badge reads consistently instead of each surface inventing its own colors.
 */
export type StatusTone = "ok" | "warn" | "bad" | "neutral";

const TONE_STYLES: Record<StatusTone, string> = {
  ok: "border-emerald-200 bg-emerald-100 text-emerald-900",
  warn: "border-amber-200 bg-amber-100 text-amber-900",
  bad: "border-red-200 bg-red-100 text-red-900",
  neutral: "border-stone-200 bg-stone-100 text-stone-700",
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>{children}</span>;
}

/** node summary status -> tone */
export function nodeStatusTone(status: "active" | "degraded" | "pending" | "offline"): StatusTone {
  switch (status) {
    case "active":
      return "ok";
    case "degraded":
      return "warn";
    case "pending":
      return "neutral";
    case "offline":
      return "bad";
  }
}

/** fleet camera status -> tone */
export function cameraStatusTone(status: "available" | "unavailable" | "disabled" | "retired" | "node-offline"): StatusTone {
  switch (status) {
    case "available":
      return "ok";
    case "unavailable":
    case "node-offline":
      return "warn";
    case "disabled":
    case "retired":
      return "neutral";
  }
}

/** canonical sensor health -> tone */
export function sensorHealthTone(state: "healthy" | "intermittent" | "degraded" | "failed" | "node-offline"): StatusTone {
  switch (state) {
    case "healthy":
      return "ok";
    case "intermittent":
      return "warn";
    case "degraded":
      return "warn";
    case "failed":
      return "bad";
    case "node-offline":
      return "neutral";
  }
}
