"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import {
  ACTIVE_GREENHOUSE_SENSORS,
  DAY_LABELS,
  celsiusToFahrenheit,
  countSensorsNeedingAttention,
  filterActiveSensors,
  formatAge,
  formatDaysOfWeek,
  sensorStatusTone,
  summarizeEnvironment,
  SENSOR_STATUS_LABEL,
  type EnvironmentSensor,
} from "@/lib/greenhouseDisplay";
import { guidanceForCode } from "@/lib/sensorDiagnostics";
import { ConfirmActionButton } from "./ConfirmActionButton";

type PowerOutlet = {
  key: string;
  name: string;
  actualState: boolean | null;
  stateObservedAt: string | null;
  available: boolean;
  pendingCommand: { id: string; action: string; status: string; requestedAt: string; expiresAt: string } | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

type ScheduleCommand = {
  id: string;
  status: string;
  requestedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  actualState: boolean | null;
  stateObservedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type ScheduleRow = {
  id: string;
  outletKey: string;
  action: string;
  timeOfDay: string;
  daysOfWeek: number[];
  timeZone: string;
  label: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastCommand: ScheduleCommand | null;
  nextRunAt: string | null;
};

const COMMAND_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  claimed: "Claimed",
  succeeded: "Succeeded",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
};

const COMMAND_STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-200",
  claimed: "bg-amber-100 text-amber-900 border-amber-200",
  succeeded: "bg-emerald-100 text-emerald-900 border-emerald-200",
  failed: "bg-red-100 text-red-900 border-red-200",
  expired: "bg-red-100 text-red-900 border-red-200",
  cancelled: "bg-stone-100 text-stone-700 border-stone-200",
};

const POLL_INTERVAL_MS = 60_000;
const FAST_POLL_INTERVAL_MS = 5_000;
const FAST_POLL_WINDOW_MS = 60_000;

const OUTLET_LABELS: Record<string, string> = { fans: "Fans", lights: "Lights", water: "Water" };
const CONTROLLABLE_OUTLETS = ["fans", "lights"] as const;

const TONE_STYLES: Record<string, string> = {
  fresh: "bg-emerald-100 text-emerald-900 border-emerald-200",
  stale: "bg-amber-100 text-amber-900 border-amber-200",
  rejected: "bg-red-100 text-red-900 border-red-200",
  failed: "bg-red-100 text-red-900 border-red-200",
  unavailable: "bg-stone-100 text-stone-700 border-stone-200",
  on: "bg-emerald-100 text-emerald-900 border-emerald-200",
  off: "bg-stone-100 text-stone-700 border-stone-200",
  unknown: "bg-amber-100 text-amber-900 border-amber-200",
};

const DEFAULT_SCHEDULE_FORM = {
  outletKey: "lights" as string,
  action: "on" as string,
  timeOfDay: "07:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  label: "",
};

export function GreenhousePanel({ nodeName }: { nodeName: string }) {
  const [sensors, setSensors] = useState<EnvironmentSensor[] | null>(null);
  const [outlets, setOutlets] = useState<PowerOutlet[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [nodeMissing, setNodeMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [commandState, setCommandState] = useState<Record<string, { submitting: boolean; error: string | null }>>({});
  const [scheduleForm, setScheduleForm] = useState(DEFAULT_SCHEDULE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const fastPollUntil = useRef(0);

  const load = useCallback(async () => {
    try {
      const [envRes, powerRes, scheduleRes] = await Promise.all([
        fetch(`/api/nodes/${nodeName}/environment`, { cache: "no-store" }),
        fetch(`/api/nodes/${nodeName}/power`, { cache: "no-store" }),
        fetch(`/api/nodes/${nodeName}/power/schedules`, { cache: "no-store" }),
      ]);

      if (envRes.status === 404 || powerRes.status === 404 || scheduleRes.status === 404) {
        setNodeMissing(true);
        return;
      }
      if (!envRes.ok || !powerRes.ok || !scheduleRes.ok) {
        setLoadError("Could not load greenhouse status from the coordinator.");
        return;
      }

      const env = await envRes.json();
      const power = await powerRes.json();
      const scheduleData = await scheduleRes.json();

      setNodeMissing(false);
      setLoadError(null);
      setSensors(env.sensors);
      setOutlets(power.outlets);
      setSchedules(scheduleData.schedules);
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number;

    function scheduleNext() {
      const interval = Date.now() < fastPollUntil.current ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
      timeoutId = window.setTimeout(async () => {
        if (cancelled) return;
        await load();
        if (!cancelled) scheduleNext();
      }, interval);
    }

    void load();
    scheduleNext();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [load]);

  function triggerFastPoll() {
    fastPollUntil.current = Date.now() + FAST_POLL_WINDOW_MS;
  }

  async function sendCommand(outletKey: string, action: "on" | "off") {
    setCommandState((prev) => ({ ...prev, [outletKey]: { submitting: true, error: null } }));
    try {
      const response = await fetch(`/api/nodes/${nodeName}/power/${outletKey}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setCommandState((prev) => ({ ...prev, [outletKey]: { submitting: false, error: data.error ?? "Command failed." } }));
        return;
      }
      setCommandState((prev) => ({ ...prev, [outletKey]: { submitting: false, error: null } }));
      triggerFastPoll();
      await load();
    } catch {
      setCommandState((prev) => ({ ...prev, [outletKey]: { submitting: false, error: "Could not reach the coordinator." } }));
    }
  }

  function startEditSchedule(schedule: ScheduleRow) {
    setEditingId(schedule.id);
    setScheduleForm({
      outletKey: schedule.outletKey,
      action: schedule.action,
      timeOfDay: schedule.timeOfDay,
      days: schedule.daysOfWeek,
      label: schedule.label ?? "",
    });
    setScheduleError(null);
  }

  function cancelScheduleForm() {
    setEditingId(null);
    setScheduleForm(DEFAULT_SCHEDULE_FORM);
    setScheduleError(null);
  }

  function toggleFormDay(day: number) {
    setScheduleForm((prev) => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter((value) => value !== day) : [...prev.days, day].sort((a, b) => a - b),
    }));
  }

  async function submitScheduleForm(event: FormEvent) {
    event.preventDefault();
    if (scheduleBusy) return;
    setScheduleBusy(true);
    setScheduleError(null);

    const payload = {
      outletKey: scheduleForm.outletKey,
      action: scheduleForm.action,
      timeOfDay: scheduleForm.timeOfDay,
      daysOfWeek: scheduleForm.days,
      label: scheduleForm.label.trim() || null,
    };

    try {
      const url = editingId
        ? `/api/nodes/${nodeName}/power/schedules/${editingId}`
        : `/api/nodes/${nodeName}/power/schedules`;
      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setScheduleError(data.error ?? "Could not save timer.");
        return;
      }
      cancelScheduleForm();
      await load();
    } catch {
      setScheduleError("Could not reach the coordinator.");
    } finally {
      setScheduleBusy(false);
    }
  }

  async function toggleScheduleEnabled(schedule: ScheduleRow) {
    await fetch(`/api/nodes/${nodeName}/power/schedules/${schedule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !schedule.enabled }),
    });
    await load();
  }

  async function deleteSchedule(id: string): Promise<boolean> {
    const response = await fetch(`/api/nodes/${nodeName}/power/schedules/${id}`, { method: "DELETE" });
    if (!response.ok) return false;
    await load();
    return true;
  }

  if (nodeMissing) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-600">
        Greenhouse node &ldquo;{nodeName}&rdquo; is not registered with the coordinator.
      </div>
    );
  }

  const activeSlots = filterActiveSensors(sensors ?? []);
  const summary = summarizeEnvironment(activeSlots);
  const loading = sensors === null && outlets === null && !loadError;
  const attentionCount = sensors ? countSensorsNeedingAttention(activeSlots) : 0;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-stone-950">
            <Link href={`/nodes/${nodeName}`} className="hover:underline">
              Greenhouse &mdash; {nodeName}
            </Link>
          </h2>
          {attentionCount > 0 ? (
            <span className="rounded-md border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
              {attentionCount} sensor{attentionCount === 1 ? "" : "s"} need{attentionCount === 1 ? "s" : ""} attention
            </span>
          ) : null}
        </div>
        {loading ? <span className="text-sm text-stone-600">Loading greenhouse status...</span> : null}
      </div>

      {loadError ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {activeSlots.map(({ key, label, sensor }) => {
          const tone = sensorStatusTone(sensor);
          const hasReading = sensor && tone === "fresh" && sensor.latestTemperatureC !== null && sensor.latestHumidityPct !== null;
          const guidance = tone !== "fresh" ? guidanceForCode(sensor?.lastDiagnosticCode) : null;

          return (
            <Link
              key={key}
              href={`/nodes/${nodeName}/sensors/${key}`}
              className="grid rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-300"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-stone-950">{label}</h3>
                  <p className="text-xs text-stone-500" aria-label={`Sensor ID ${key}`}>
                    {key}
                  </p>
                </div>
                <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>
                  {SENSOR_STATUS_LABEL[tone]}
                </span>
              </div>

              {hasReading ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-2xl font-semibold text-stone-950">
                      {celsiusToFahrenheit(sensor!.latestTemperatureC!).toFixed(1)}&deg;F
                    </p>
                    <p className="text-xs text-stone-500">{sensor!.latestTemperatureC!.toFixed(1)}&deg;C</p>
                  </div>
                  <div>
                    <p className="text-2xl font-semibold text-stone-950">{sensor!.latestHumidityPct!.toFixed(0)}%</p>
                    <p className="text-xs text-stone-500">Relative humidity</p>
                  </div>
                </div>
              ) : (
                <div className="mt-3 text-sm text-stone-600">
                  <p>{tone === "unavailable" ? "No data received yet." : guidance?.label ?? `No valid reading (${SENSOR_STATUS_LABEL[tone].toLowerCase()}).`}</p>
                  {sensor?.lastDiagnosticMessage ? <p className="mt-1 text-xs text-stone-500">{sensor.lastDiagnosticMessage}</p> : null}
                </div>
              )}

              <p className="mt-3 text-xs text-stone-500">
                Last accepted:{" "}
                {sensor?.lastAcceptedAt ? `${formatAge(sensor.lastAcceptedAt)} (${formatDateTime(sensor.lastAcceptedAt)})` : "never"}
              </p>

              {!hasReading ? <p className="mt-2 text-xs font-semibold text-emerald-700">View diagnostics &rarr;</p> : null}
            </Link>
          );
        })}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold text-stone-950">Environmental summary</h3>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <dt className="font-medium text-stone-950">Hottest</dt>
            <dd className="text-stone-600">{summary.hottest ? `${summary.hottest.fahrenheit.toFixed(1)}°F (${summary.hottest.label})` : "-"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Coolest</dt>
            <dd className="text-stone-600">{summary.coolest ? `${summary.coolest.fahrenheit.toFixed(1)}°F (${summary.coolest.label})` : "-"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Highest humidity</dt>
            <dd className="text-stone-600">{summary.highestHumidity ? `${summary.highestHumidity.pct.toFixed(0)}% (${summary.highestHumidity.label})` : "-"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Lowest humidity</dt>
            <dd className="text-stone-600">{summary.lowestHumidity ? `${summary.lowestHumidity.pct.toFixed(0)}% (${summary.lowestHumidity.label})` : "-"}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Latest update</dt>
            <dd className="text-stone-600">{formatAge(summary.latestUpdateAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CONTROLLABLE_OUTLETS.map((outletKey) => {
          const outlet = outlets?.find((candidate) => candidate.key === outletKey) ?? null;
          const state = commandState[outletKey];
          const pending = outlet?.pendingCommand ?? null;
          const busy = Boolean(state?.submitting) || Boolean(pending);
          const tone = !outlet || !outlet.available ? "unavailable" : outlet.actualState === true ? "on" : outlet.actualState === false ? "off" : "unknown";
          const label = tone === "on" ? "ON" : tone === "off" ? "OFF" : tone === "unknown" ? "UNKNOWN" : "UNAVAILABLE";

          return (
            <div key={outletKey} className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-stone-950">{OUTLET_LABELS[outletKey]}</h3>
                <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>{label}</span>
              </div>

              <p className="mt-2 text-xs text-stone-500">
                Last observed:{" "}
                {outlet?.stateObservedAt ? `${formatAge(outlet.stateObservedAt)} (${formatDateTime(outlet.stateObservedAt)})` : "never observed"}
              </p>

              {pending ? (
                <p className="mt-2 text-sm font-medium text-amber-700" role="status">
                  Command pending: turning {pending.action.toUpperCase()}&hellip;
                </p>
              ) : null}
              {outlet?.lastErrorMessage ? <p className="mt-2 text-sm text-red-700">Last error: {outlet.lastErrorMessage}</p> : null}
              {state?.error ? (
                <p className="mt-2 text-sm text-red-700" role="alert">
                  {state.error}
                </p>
              ) : null}

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  aria-label={`Turn ${OUTLET_LABELS[outletKey]} on`}
                  onClick={() => sendCommand(outletKey, "on")}
                >
                  {state?.submitting ? "Sending..." : "Turn ON"}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  aria-label={`Turn ${OUTLET_LABELS[outletKey]} off`}
                  onClick={() => sendCommand(outletKey, "off")}
                >
                  {state?.submitting ? "Sending..." : "Turn OFF"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {(() => {
        const water = outlets?.find((candidate) => candidate.key === "water") ?? null;
        const label = water?.actualState === true ? "ON" : water?.actualState === false ? "OFF" : "unknown";
        return (
          <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
            <span className="font-medium text-stone-950">Water:</span> Reserved for future irrigation. Observed state: {label}.
          </p>
        );
      })()}

      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold text-stone-950">Daily timers</h3>

        {schedules === null ? (
          <p className="mt-3 text-sm text-stone-600">Loading timers...</p>
        ) : schedules.length === 0 ? (
          <p className="mt-3 text-sm text-stone-600">No timers yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-stone-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-xs font-semibold uppercase text-stone-600">
                <tr>
                  <th className="px-3 py-2">Outlet</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Days</th>
                  <th className="px-3 py-2">Label</th>
                  <th className="px-3 py-2">Next run</th>
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2">Enabled</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id} className="border-t border-stone-100 align-top">
                    <td className="px-3 py-2 font-medium text-stone-950">{OUTLET_LABELS[schedule.outletKey] ?? schedule.outletKey}</td>
                    <td className="px-3 py-2 text-stone-600">{schedule.action.toUpperCase()}</td>
                    <td className="px-3 py-2 text-stone-600">
                      {schedule.timeOfDay} <span className="text-xs">{schedule.timeZone}</span>
                    </td>
                    <td className="px-3 py-2 text-stone-600">{formatDaysOfWeek(schedule.daysOfWeek)}</td>
                    <td className="px-3 py-2 text-stone-600">{schedule.label || "-"}</td>
                    <td className="px-3 py-2 text-stone-600">
                      {schedule.enabled ? (schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "-") : "Disabled"}
                    </td>
                    <td className="px-3 py-2 text-stone-600">
                      {schedule.lastCommand ? (
                        <div className="grid gap-0.5">
                          <span
                            className={`inline-flex w-fit rounded-md border px-1.5 py-0.5 text-xs font-semibold ${
                              COMMAND_STATUS_TONE[schedule.lastCommand.status] ?? "border-stone-200 bg-stone-100 text-stone-700"
                            }`}
                          >
                            {COMMAND_STATUS_LABEL[schedule.lastCommand.status] ?? schedule.lastCommand.status}
                          </span>
                          <span className="text-xs">Queued {formatAge(schedule.lastCommand.requestedAt)}</span>
                          {schedule.lastCommand.claimedAt ? <span className="text-xs">Claimed {formatAge(schedule.lastCommand.claimedAt)}</span> : null}
                          {schedule.lastCommand.completedAt ? <span className="text-xs">Completed {formatAge(schedule.lastCommand.completedAt)}</span> : null}
                          {schedule.lastCommand.status === "succeeded" && schedule.lastCommand.actualState !== null ? (
                            <span className="text-xs">Observed: {schedule.lastCommand.actualState ? "ON" : "OFF"}</span>
                          ) : null}
                          {(schedule.lastCommand.status === "failed" || schedule.lastCommand.status === "expired") && schedule.lastCommand.errorMessage ? (
                            <span className="text-xs text-red-700">{schedule.lastCommand.errorMessage}</span>
                          ) : null}
                        </div>
                      ) : schedule.lastRunStatus === "error" ? (
                        <div className="grid gap-0.5">
                          <span className="inline-flex w-fit rounded-md border border-red-200 bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-900">
                            Scheduling failed
                          </span>
                          {schedule.lastRunError ? <span className="text-xs text-red-700">{schedule.lastRunError}</span> : null}
                        </div>
                      ) : (
                        "Never run"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={schedule.enabled}
                          onChange={() => toggleScheduleEnabled(schedule)}
                          aria-label={`Enable ${OUTLET_LABELS[schedule.outletKey]} ${schedule.action} timer at ${schedule.timeOfDay}`}
                        />
                      </label>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="button-secondary" onClick={() => startEditSchedule(schedule)}>
                          Edit
                        </button>
                        <ConfirmActionButton
                          title="Delete this timer?"
                          message={`Delete the ${schedule.action.toUpperCase()} ${OUTLET_LABELS[schedule.outletKey]} timer at ${schedule.timeOfDay}? This cannot be undone.`}
                          confirmLabel="Delete"
                          onConfirm={() => deleteSchedule(schedule.id)}
                        >
                          Delete
                        </ConfirmActionButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form className="mt-4 grid gap-3 rounded-md border border-stone-200 p-3" onSubmit={submitScheduleForm}>
          <h4 className="text-sm font-semibold text-stone-950">{editingId ? "Edit timer" : "Add a timer"}</h4>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="field">
              <span className="text-xs font-medium text-stone-700">Outlet</span>
              <select
                className="input"
                value={scheduleForm.outletKey}
                onChange={(event) => setScheduleForm((prev) => ({ ...prev, outletKey: event.target.value }))}
              >
                <option value="lights">Lights</option>
                <option value="fans">Fans</option>
              </select>
            </label>

            <label className="field">
              <span className="text-xs font-medium text-stone-700">Action</span>
              <select
                className="input"
                value={scheduleForm.action}
                onChange={(event) => setScheduleForm((prev) => ({ ...prev, action: event.target.value }))}
              >
                <option value="on">Turn ON</option>
                <option value="off">Turn OFF</option>
              </select>
            </label>

            <label className="field">
              <span className="text-xs font-medium text-stone-700">Time</span>
              <input
                type="time"
                className="input"
                value={scheduleForm.timeOfDay}
                onChange={(event) => setScheduleForm((prev) => ({ ...prev, timeOfDay: event.target.value }))}
                required
              />
            </label>

            <label className="field">
              <span className="text-xs font-medium text-stone-700">Label (optional)</span>
              <input
                type="text"
                className="input"
                value={scheduleForm.label}
                maxLength={120}
                placeholder="e.g. Morning lights"
                onChange={(event) => setScheduleForm((prev) => ({ ...prev, label: event.target.value }))}
              />
            </label>
          </div>

          <fieldset>
            <legend className="text-xs font-medium text-stone-700">Days</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {DAY_LABELS.map((dayLabel, day) => (
                <label key={dayLabel} className="inline-flex items-center gap-1 text-sm text-stone-700">
                  <input type="checkbox" checked={scheduleForm.days.includes(day)} onChange={() => toggleFormDay(day)} />
                  {dayLabel}
                </label>
              ))}
            </div>
          </fieldset>

          {scheduleError ? (
            <p className="text-sm text-red-700" role="alert">
              {scheduleError}
            </p>
          ) : null}

          <div className="flex gap-2">
            <button type="submit" className="button" disabled={scheduleBusy}>
              {scheduleBusy ? "Saving..." : editingId ? "Save changes" : "Create timer"}
            </button>
            {editingId ? (
              <button type="button" className="button-secondary" onClick={cancelScheduleForm}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

// Re-exported so tests/consumers don't need to duplicate the active sensor list.
export { ACTIVE_GREENHOUSE_SENSORS };
