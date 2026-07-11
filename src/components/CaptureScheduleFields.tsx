"use client";

import { useMemo } from "react";
import { captureWindowLabel, nextPermittedCaptureTimes, validateCaptureWindowConfig } from "@/lib/schedule";
import {
  COMMON_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  formatDateTimeInZone,
  isValidTimeZone,
  minutesToTimeInput,
  safeTimeInputToMinutes,
  timeInputToMinutes,
} from "@/lib/timezone";

export type CaptureScheduleValue = {
  timeZone: string;
  photoIntervalMinutes: string;
  captureStartAt: string;
  captureWindowEnabled: boolean;
  captureWindowStart: string;
  captureWindowEnd: string;
};

export function browserTimeZone() {
  if (typeof Intl === "undefined") {
    return DEFAULT_TIME_ZONE;
  }

  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(resolved) ? resolved : DEFAULT_TIME_ZONE;
}

function schedulePreview(value: CaptureScheduleValue) {
  if (!isValidTimeZone(value.timeZone) || !value.captureStartAt) {
    return { errors: ["Choose a valid IANA timezone."], captures: [] as Date[] };
  }

  try {
    const startMinutes = timeInputToMinutes(value.captureWindowStart);
    const endMinutes = timeInputToMinutes(value.captureWindowEnd);
    const intervalMinutes = Number.parseInt(value.photoIntervalMinutes, 10);
    const config = {
      timeZone: value.timeZone,
      captureWindowEnabled: value.captureWindowEnabled,
      captureWindowStartMinutes: startMinutes,
      captureWindowEndMinutes: endMinutes,
    };
    const errors = validateCaptureWindowConfig(config);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
      errors.push("Photo interval must be a positive whole number of minutes.");
    }
    if (errors.length > 0) {
      return { errors, captures: [] as Date[] };
    }

    const captures = nextPermittedCaptureTimes({
      ...config,
      startAt: new Date(value.captureStartAt),
      intervalMinutes,
      count: 5,
    });
    return { errors: [], captures };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "Invalid schedule."], captures: [] as Date[] };
  }
}

export function CaptureScheduleFields({
  value,
  onChange,
  disabled = false,
}: {
  value: CaptureScheduleValue;
  onChange: (patch: Partial<CaptureScheduleValue>) => void;
  disabled?: boolean;
}) {
  const preview = useMemo(() => schedulePreview(value), [value]);
  const interval = Number.parseInt(value.photoIntervalMinutes, 10);
  const startMinutes = safeTimeInputToMinutes(value.captureWindowStart) ?? 0;
  const endMinutes = safeTimeInputToMinutes(value.captureWindowEnd) ?? 0;
  const summary = captureWindowLabel({
    timeZone: value.timeZone,
    captureWindowEnabled: value.captureWindowEnabled,
    captureWindowStartMinutes: startMinutes,
    captureWindowEndMinutes: endMinutes,
  });

  return (
    <div className="grid gap-4 rounded-md border border-stone-200 bg-stone-50 p-3" data-testid="capture-schedule-fields">
      <label className="field">
        Timezone
        <input
          className="input"
          name="timeZone"
          list="plantlab-time-zones"
          value={value.timeZone}
          onChange={(event) => onChange({ timeZone: event.target.value })}
          disabled={disabled}
          required
        />
        <datalist id="plantlab-time-zones">
          {COMMON_TIME_ZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </label>
      <p className={`text-sm font-semibold ${isValidTimeZone(value.timeZone) ? "text-stone-800" : "text-red-700"}`}>
        Selected timezone: {value.timeZone || "None"}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          Interval
          <input
            className="input"
            name="photoIntervalMinutes"
            type="number"
            min="1"
            value={value.photoIntervalMinutes}
            onChange={(event) => onChange({ photoIntervalMinutes: event.target.value })}
            disabled={disabled}
            required
          />
        </label>
        <label className="field">
          Schedule anchor
          <input
            className="input"
            name="captureStartAt"
            type="datetime-local"
            value={value.captureStartAt}
            onChange={(event) => onChange({ captureStartAt: event.target.value })}
            disabled={disabled}
            required
          />
        </label>
      </div>

      <div className="grid gap-3 rounded-md border border-stone-200 bg-white p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
          <input
            type="checkbox"
            checked={value.captureWindowEnabled}
            onChange={(event) => onChange({ captureWindowEnabled: event.target.checked })}
            disabled={disabled}
          />
          Limit captures to a daily window
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field">
            From
            <input
              className="input"
              type="time"
              value={value.captureWindowStart}
              onChange={(event) => onChange({ captureWindowStart: event.target.value })}
              disabled={disabled || !value.captureWindowEnabled}
            />
          </label>
          <label className="field">
            Until
            <input
              className="input"
              type="time"
              value={value.captureWindowEnd}
              onChange={(event) => onChange({ captureWindowEnd: event.target.value })}
              disabled={disabled || !value.captureWindowEnabled}
            />
          </label>
        </div>
        <p className="text-xs text-stone-500">Equal start and end times mean a 24-hour allowed window.</p>
      </div>

      <div className="rounded-md border border-stone-200 bg-white p-3 text-sm text-stone-700">
        <p>
          Photos will be taken every {Number.isFinite(interval) ? interval : "?"} minutes during {summary}.
        </p>
        {preview.errors.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-amber-800">
            {preview.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : (
          <ol className="mt-2 grid gap-1 text-xs text-stone-600">
            {preview.captures.map((capture) => (
              <li key={capture.toISOString()}>{formatDateTimeInZone(capture, value.timeZone)}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function captureSchedulePayload(value: CaptureScheduleValue) {
  return {
    timeZone: value.timeZone,
    photoIntervalMinutes: value.photoIntervalMinutes,
    captureStartAt: new Date(value.captureStartAt).toISOString(),
    captureWindowEnabled: value.captureWindowEnabled,
    captureWindowStartMinutes: value.captureWindowEnabled ? safeTimeInputToMinutes(value.captureWindowStart) : null,
    captureWindowEndMinutes: value.captureWindowEnabled ? safeTimeInputToMinutes(value.captureWindowEnd) : null,
  };
}

export function initialScheduleValue(input: {
  timeZone?: string | null;
  photoIntervalMinutes: number | string;
  captureStartAt: string;
  captureWindowEnabled?: boolean;
  captureWindowStartMinutes?: number | null;
  captureWindowEndMinutes?: number | null;
}): CaptureScheduleValue {
  return {
    timeZone: input.timeZone ?? browserTimeZone(),
    photoIntervalMinutes: String(input.photoIntervalMinutes),
    captureStartAt: input.captureStartAt,
    captureWindowEnabled: input.captureWindowEnabled ?? false,
    captureWindowStart: minutesToTimeInput(input.captureWindowStartMinutes ?? 6 * 60),
    captureWindowEnd: minutesToTimeInput(input.captureWindowEndMinutes ?? 22 * 60),
  };
}
