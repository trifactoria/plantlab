"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { canOutletUsePermanentOn, DAY_LABELS, formatAge, formatDaysOfWeek, orderOutlets, outletLabel, type OutletBehaviorValue } from "@/lib/greenhouseDisplay";
import { ConfirmActionButton } from "./ConfirmActionButton";

export type PowerOutlet = {
  key: string;
  name: string;
  enabled: boolean;
  behavior: OutletBehaviorValue;
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

const TONE_STYLES: Record<string, string> = {
  unavailable: "bg-stone-100 text-stone-700 border-stone-200",
  on: "bg-emerald-100 text-emerald-900 border-emerald-200",
  off: "bg-stone-100 text-stone-700 border-stone-200",
  unknown: "bg-amber-100 text-amber-900 border-amber-200",
};

const POLL_INTERVAL_MS = 60_000;
const FAST_POLL_INTERVAL_MS = 5_000;
const FAST_POLL_WINDOW_MS = 60_000;

const DEFAULT_SCHEDULE_FORM = {
  outletKey: "" as string,
  action: "on" as string,
  timeOfDay: "07:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  label: "",
};

/**
 * Outlet controls (ON/OFF/pulse-only policy display) and daily timers for
 * one node's power outlets. Fully generic over the outlet set - reads
 * behavior from the API response rather than any hardcoded outlet list.
 * Shared between GreenhousePanel (embedded on the node overview) and the
 * dedicated /nodes/[nodeName]/power subsystem page.
 */
export function PowerControlPanel({ nodeName }: { nodeName: string }) {
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
      const [powerRes, scheduleRes] = await Promise.all([
        fetch(`/api/nodes/${nodeName}/power`, { cache: "no-store" }),
        fetch(`/api/nodes/${nodeName}/power/schedules`, { cache: "no-store" }),
      ]);

      if (powerRes.status === 404 || scheduleRes.status === 404) {
        setNodeMissing(true);
        return;
      }
      if (!powerRes.ok || !scheduleRes.ok) {
        setLoadError("Could not load power status from the coordinator.");
        return;
      }

      const power = await powerRes.json();
      const scheduleData = await scheduleRes.json();

      setNodeMissing(false);
      setLoadError(null);
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

  // Outlets eligible for scheduling: enabled, in stable friendly-label-first
  // order. Includes pulse-only outlets (they can still be scheduled OFF) -
  // per-outlet action availability is filtered separately below.
  const schedulableOutlets = useMemo(() => orderOutlets((outlets ?? []).filter((outlet) => outlet.enabled)), [outlets]);
  const selectedScheduleOutlet = schedulableOutlets.find((outlet) => outlet.key === scheduleForm.outletKey) ?? null;

  useEffect(() => {
    if (editingId || scheduleForm.outletKey) return;
    if (schedulableOutlets.length === 0) return;
    setScheduleForm((prev) => ({ ...prev, outletKey: schedulableOutlets[0].key }));
  }, [editingId, scheduleForm.outletKey, schedulableOutlets]);

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
      const url = editingId ? `/api/nodes/${nodeName}/power/schedules/${editingId}` : `/api/nodes/${nodeName}/power/schedules`;
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
        Node &ldquo;{nodeName}&rdquo; is not registered with the coordinator.
      </div>
    );
  }

  const loading = outlets === null && schedules === null && !loadError;

  return (
    <div className="grid grid-cols-1 gap-4">
      {loading ? <span className="text-sm text-stone-600">Loading power status...</span> : null}
      {loadError ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {orderOutlets(outlets ?? []).map((outlet) => {
          const outletKey = outlet.key;
          const label = outletLabel(outlet);
          const state = commandState[outletKey];
          const pending = outlet.pendingCommand;
          const busy = Boolean(state?.submitting) || Boolean(pending);
          const canOn = outlet.enabled && canOutletUsePermanentOn(outlet.behavior);
          const isPulseOnly = outlet.behavior === "pulse-only";
          const tone = !outlet.enabled
            ? "unavailable"
            : !outlet.available
              ? "unavailable"
              : outlet.actualState === true
                ? "on"
                : outlet.actualState === false
                  ? "off"
                  : "unknown";
          const stateLabel = !outlet.enabled ? "DISABLED" : tone === "on" ? "ON" : tone === "off" ? "OFF" : tone === "unknown" ? "UNKNOWN" : "UNAVAILABLE";

          return (
            <div key={outletKey} className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-stone-950">{label}</h3>
                <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>{stateLabel}</span>
              </div>

              {isPulseOnly ? (
                <p className="mt-1 text-xs font-medium text-stone-500">Pulse-only outlet - bounded on-time control is not available in this view yet.</p>
              ) : null}

              <p className="mt-2 text-xs text-stone-500">
                Last observed:{" "}
                {outlet.stateObservedAt ? `${formatAge(outlet.stateObservedAt)} (${formatDateTime(outlet.stateObservedAt)})` : "never observed"}
              </p>

              {pending ? (
                <p className="mt-2 text-sm font-medium text-amber-700" role="status">
                  Command pending: turning {pending.action.toUpperCase()}&hellip;
                </p>
              ) : null}
              {outlet.lastErrorMessage ? <p className="mt-2 text-sm text-red-700">Last error: {outlet.lastErrorMessage}</p> : null}
              {state?.error ? (
                <p className="mt-2 text-sm text-red-700" role="alert">
                  {state.error}
                </p>
              ) : null}

              <div className="mt-3 flex gap-2">
                {canOn ? (
                  <button type="button" className="button" disabled={busy} aria-label={`Turn ${label} on`} onClick={() => sendCommand(outletKey, "on")}>
                    {state?.submitting ? "Sending..." : "Turn ON"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || !outlet.enabled}
                  aria-label={`Turn ${label} off`}
                  onClick={() => sendCommand(outletKey, "off")}
                >
                  {state?.submitting ? "Sending..." : "Turn OFF"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

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
                    <td className="px-3 py-2 font-medium text-stone-950">{outletLabel({ key: schedule.outletKey })}</td>
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
                          aria-label={`Enable ${outletLabel({ key: schedule.outletKey })} ${schedule.action} timer at ${schedule.timeOfDay}`}
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
                          message={`Delete the ${schedule.action.toUpperCase()} ${outletLabel({ key: schedule.outletKey })} timer at ${schedule.timeOfDay}? This cannot be undone.`}
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="field">
              <span className="text-xs font-medium text-stone-700">Outlet</span>
              <select
                className="input"
                value={scheduleForm.outletKey}
                disabled={schedulableOutlets.length === 0}
                onChange={(event) => {
                  const nextKey = event.target.value;
                  const nextOutlet = schedulableOutlets.find((outlet) => outlet.key === nextKey);
                  setScheduleForm((prev) => ({
                    ...prev,
                    outletKey: nextKey,
                    action: nextOutlet && !canOutletUsePermanentOn(nextOutlet.behavior) ? "off" : prev.action,
                  }));
                }}
              >
                {schedulableOutlets.length === 0 ? <option value="">Loading outlets...</option> : null}
                {scheduleForm.outletKey && !schedulableOutlets.some((outlet) => outlet.key === scheduleForm.outletKey) ? (
                  <option value={scheduleForm.outletKey}>{outletLabel({ key: scheduleForm.outletKey })}</option>
                ) : null}
                {schedulableOutlets.map((outlet) => (
                  <option key={outlet.key} value={outlet.key}>
                    {outletLabel(outlet)}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="text-xs font-medium text-stone-700">Action</span>
              <select className="input" value={scheduleForm.action} onChange={(event) => setScheduleForm((prev) => ({ ...prev, action: event.target.value }))}>
                {!selectedScheduleOutlet || canOutletUsePermanentOn(selectedScheduleOutlet.behavior) ? <option value="on">Turn ON</option> : null}
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
