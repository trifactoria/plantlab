import { formatDateTime } from "@/lib/format";
import { formatMinuteOfDay } from "./cameraFormat";

/**
 * Read-only summary of a shared source's physical capture schedule: base
 * cadence, active daily window, and timezone. This is the SOURCE cadence, not
 * any project's sampling interval. A window ending at minute 0 renders as
 * "12:00 AM" and means the exclusive end of the operating day (a cross-midnight
 * window such as 8:00 AM through the end of the day).
 */
export function CameraScheduleSummary({
  intervalMinutes,
  timeZone,
  windowEnabled,
  windowStartMinutes,
  windowEndMinutes,
  nextCaptureAt,
  enabled = true,
}: {
  intervalMinutes: number | null;
  timeZone: string | null;
  windowEnabled: boolean;
  windowStartMinutes: number | null;
  windowEndMinutes: number | null;
  nextCaptureAt?: string | null;
  enabled?: boolean;
}) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="camera-schedule-summary">
      <div>
        <dt className="font-medium text-stone-950">Source cadence</dt>
        <dd className="text-stone-600">
          {!enabled ? "Scheduled capture disabled" : intervalMinutes ? `Every ${intervalMinutes} minutes` : "Not scheduled"}
        </dd>
      </div>
      <div>
        <dt className="font-medium text-stone-950">Active window</dt>
        <dd className="text-stone-600">
          {windowEnabled
            ? `${formatMinuteOfDay(windowStartMinutes)}–${formatMinuteOfDay(windowEndMinutes)}`
            : "All day"}
        </dd>
      </div>
      <div>
        <dt className="font-medium text-stone-950">Timezone</dt>
        <dd className="text-stone-600">{timeZone ?? "-"}</dd>
      </div>
      {nextCaptureAt !== undefined ? (
        <div>
          <dt className="font-medium text-stone-950">Next source capture</dt>
          <dd className="text-stone-600">{nextCaptureAt ? formatDateTime(nextCaptureAt) : "-"}</dd>
        </div>
      ) : null}
    </dl>
  );
}
