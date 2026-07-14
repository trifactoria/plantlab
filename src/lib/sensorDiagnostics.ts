/**
 * Maps the machine-readable diagnostic codes emitted by the edge sensor
 * drivers (edge-agent/plantlab_edge_agent/sensors/dht22.py, mock.py,
 * validation.py) to a broad category and operator-facing guidance. Pure,
 * framework-free, and shared by the sensor detail page and any future
 * doctor-style summary - see AGENTS.md "map known codes to useful operator
 * guidance," and note the task's own instruction: label these as *likely*
 * causes, never a claimed diagnosis - the evidence available server-side
 * can't distinguish a bad sensor from a bad wire from a bad connector.
 */

export type DiagnosticCategory =
  | "no-response"
  | "checksum"
  | "timeout"
  | "hard-bound"
  | "plausible-bound"
  | "transport"
  | "driver-unavailable"
  | "stale"
  | "not-configured"
  | "unknown";

export type DiagnosticGuidance = {
  category: DiagnosticCategory;
  label: string;
  likelyCauses: string[];
};

const NO_RESPONSE: DiagnosticGuidance = {
  category: "no-response",
  label: "No response from the sensor",
  likelyCauses: [
    "Verify the sensor has 3.3V power and a solid ground connection.",
    "Check data wire continuity between the sensor and the header pin.",
    "Verify the configured BCM GPIO matches the physical wiring.",
    "Check the pull-up resistor on the data line, if the sensor module doesn't include one.",
    "Reseat the connector at both ends.",
    "Test the sensor individually with \"Run sensor test\" to rule out interference from other wiring.",
  ],
};

const CHECKSUM: DiagnosticGuidance = {
  category: "checksum",
  label: "Checksum mismatch",
  likelyCauses: [
    "Inspect wire length and solder joints - long or poorly-joined runs corrupt the DHT22's bit-banged signal.",
    "Route the data wire away from fan, pump, or other switched power wiring.",
    "Confirm the sensor's supply voltage is stable, not sagging under load.",
    "Retry after stopping nearby electrical noise sources, if practical.",
  ],
};

const TIMEOUT: DiagnosticGuidance = {
  category: "timeout",
  label: "Incomplete response (timed out)",
  likelyCauses: [
    "The sensor responded but the full 40-bit frame was not received in time.",
    "Suggests intermittent connection or marginal timing rather than a fully dead sensor.",
    "Check for a loose connector or a marginal pull-up resistor.",
  ],
};

const HARD_BOUND: DiagnosticGuidance = {
  category: "hard-bound",
  label: "Reading outside physically possible range",
  likelyCauses: [
    "The decoded value is outside the DHT22's physical operating range and was rejected rather than stored as a measurement.",
    "Usually indicates a corrupted read (wiring/noise) rather than an actual environmental extreme.",
  ],
};

const PLAUSIBLE_BOUND: DiagnosticGuidance = {
  category: "plausible-bound",
  label: "Reading outside expected greenhouse range",
  likelyCauses: [
    "The value is physically valid but outside the configured plausible range or changed faster than expected.",
    "Confirm with a second reading before treating this as a real environmental change.",
  ],
};

const TRANSPORT: DiagnosticGuidance = {
  category: "transport",
  label: "GPIO/driver transport failure",
  likelyCauses: [
    "pigpiod may not be running - check `systemctl status pigpiod` on the node.",
    "The current user may not have GPIO permissions (should be in the gpio group).",
    "Another process may be holding the GPIO line.",
  ],
};

const DRIVER_UNAVAILABLE: DiagnosticGuidance = {
  category: "driver-unavailable",
  label: "Sensor driver unavailable",
  likelyCauses: [
    "The pigpio Python package or daemon is not installed/reachable on this node.",
    "Run `plantlab-edge doctor` on the node to check backend readiness.",
  ],
};

const STALE: DiagnosticGuidance = {
  category: "stale",
  label: "No accepted reading recently",
  likelyCauses: ["The sensor has not produced an accepted reading within its stale timeout - see the underlying failure reason below, if any."],
};

const NOT_CONFIGURED: DiagnosticGuidance = {
  category: "not-configured",
  label: "Sensor not configured on this node",
  likelyCauses: ["This sensor key is not present in the node's current edge configuration."],
};

const UNKNOWN: DiagnosticGuidance = {
  category: "unknown",
  label: "Unrecognized diagnostic code",
  likelyCauses: ["No specific guidance is available for this code yet."],
};

const GUIDANCE_BY_CODE: Record<string, DiagnosticGuidance> = {
  "sensor-no-response": NO_RESPONSE,
  "dht-timeout": TIMEOUT,
  "dht-checksum": CHECKSUM,
  "gpio-permission-denied": TRANSPORT,
  "gpio-unavailable": TRANSPORT,
  "gpio-busy": TRANSPORT,
  "sensor-read-error": { ...TRANSPORT, label: "Unclassified read failure" },
  "driver-read-failed": { ...TRANSPORT, label: "Unclassified read failure" },
  "driver-unavailable": DRIVER_UNAVAILABLE,
  "backend-unavailable": DRIVER_UNAVAILABLE,
  "temperature-hard-bound": HARD_BOUND,
  "humidity-hard-bound": HARD_BOUND,
  "temperature-plausible-bound": PLAUSIBLE_BOUND,
  "humidity-plausible-bound": PLAUSIBLE_BOUND,
  "temperature-sudden-change": PLAUSIBLE_BOUND,
  "humidity-sudden-change": PLAUSIBLE_BOUND,
  "suspect-expired": PLAUSIBLE_BOUND,
  "isolated-spike": PLAUSIBLE_BOUND,
  "missing-value": { ...TRANSPORT, label: "Missing measurement value" },
  "invalid-number": { ...TRANSPORT, label: "Non-numeric measurement value" },
  stale: STALE,
  "sensor-not-configured": NOT_CONFIGURED,
};

export function guidanceForCode(code: string | null | undefined): DiagnosticGuidance {
  if (!code) return UNKNOWN;
  return GUIDANCE_BY_CODE[code] ?? UNKNOWN;
}

/**
 * Distinguishes occasional DHT22 noise from a total failure using a recent
 * attempt window, per the task's "intermittent failures" guidance: only
 * recommend action after repeated failures, not a single blip.
 */
export function intermittentFailureSummary(recentOutcomes: Array<"accepted" | "failed" | "rejected">): {
  successRatePct: number;
  isIntermittent: boolean;
  isTotalFailure: boolean;
} {
  if (recentOutcomes.length === 0) {
    return { successRatePct: 0, isIntermittent: false, isTotalFailure: false };
  }
  const successes = recentOutcomes.filter((outcome) => outcome === "accepted").length;
  const successRatePct = Math.round((successes / recentOutcomes.length) * 100);
  return {
    successRatePct,
    isIntermittent: successes > 0 && successes < recentOutcomes.length,
    isTotalFailure: successes === 0,
  };
}
