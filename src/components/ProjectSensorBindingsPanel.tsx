"use client";

import { useState } from "react";
import { PROJECT_SENSOR_ROLES } from "@/lib/projectSensorRoles";
import { useAvailableProjectSensors } from "./useAvailableProjectSensors";

export type ProjectSensorBindingRow = {
  id: string;
  enabled: boolean;
  label: string | null;
  role: string;
  unlinkedAt: string | null;
  node: { id: string; name: string; role: string };
  sensor: { id: string; key: string; name: string };
};

function isLinked(binding: ProjectSensorBindingRow) {
  return binding.enabled && binding.unlinkedAt === null;
}

/**
 * Project settings sensor-binding management: link new applied/active
 * sensors, edit an existing binding's label/role, and unlink/relink -
 * mirrors the link/unlink/edit-role-label capability listed for Part 5.
 * Mutates immediately against the ProjectSensorBinding API (no separate
 * save step), unlike the project-creation checklist, which only records a
 * selection to link once the project itself exists.
 */
export function ProjectSensorBindingsPanel({ projectId, initialBindings }: { projectId: string; initialBindings: ProjectSensorBindingRow[] }) {
  const [bindings, setBindings] = useState<ProjectSensorBindingRow[]>(initialBindings);
  const [drafts, setDrafts] = useState<Record<string, { label: string; role: string }>>(() =>
    Object.fromEntries(initialBindings.map((binding) => [binding.id, { label: binding.label ?? "", role: binding.role }])),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { sensors: availableSensors, loading: loadingSensors, message: sensorMessage, reload: reloadAvailableSensors } = useAvailableProjectSensors();

  const linked = bindings.filter(isLinked);
  const historical = bindings.filter((binding) => !isLinked(binding));
  const linkedSensorIds = new Set(linked.map((binding) => binding.sensor.id));
  const linkableSensors = availableSensors.filter((sensor) => !linkedSensorIds.has(sensor.id));

  function draftFor(binding: ProjectSensorBindingRow) {
    return drafts[binding.id] ?? { label: binding.label ?? "", role: binding.role };
  }

  function setDraft(bindingId: string, patch: Partial<{ label: string; role: string }>) {
    setDrafts((current) => ({ ...current, [bindingId]: { ...(current[bindingId] ?? { label: "", role: "ambient" }), ...patch } }));
  }

  function isDirty(binding: ProjectSensorBindingRow) {
    const draft = draftFor(binding);
    return draft.label !== (binding.label ?? "") || draft.role !== binding.role;
  }

  async function patchBinding(bindingId: string, body: Record<string, unknown>) {
    setBusyId(bindingId);
    setError(null);
    const response = await fetch(`/api/projects/${projectId}/sensors/${bindingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    setBusyId(null);
    if (!response.ok) {
      setError(payload.error ?? "Could not update sensor binding.");
      return null;
    }
    setBindings((current) => current.map((binding) => (binding.id === bindingId ? payload : binding)));
    setDrafts((current) => ({ ...current, [bindingId]: { label: payload.label ?? "", role: payload.role } }));
    return payload;
  }

  async function saveDraft(binding: ProjectSensorBindingRow) {
    const draft = draftFor(binding);
    await patchBinding(binding.id, { label: draft.label.trim().length > 0 ? draft.label : null, role: draft.role });
  }

  async function unlink(binding: ProjectSensorBindingRow) {
    setBusyId(binding.id);
    setError(null);
    const response = await fetch(`/api/projects/${projectId}/sensors/${binding.id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    setBusyId(null);
    if (!response.ok) {
      setError(payload.error ?? "Could not unlink sensor.");
      return;
    }
    setBindings((current) => current.map((item) => (item.id === binding.id ? payload.binding : item)));
  }

  async function relink(binding: ProjectSensorBindingRow) {
    await patchBinding(binding.id, { enabled: true });
  }

  async function linkSensor(sensorId: string) {
    setBusyId(sensorId);
    setError(null);
    const response = await fetch(`/api/projects/${projectId}/sensors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensorId }),
    });
    const payload = await response.json().catch(() => ({}));
    setBusyId(null);
    if (!response.ok) {
      setError(payload.error ?? "Could not link sensor.");
      return;
    }
    setBindings((current) => [...current.filter((binding) => binding.id !== payload.id), payload]);
    setDrafts((current) => ({ ...current, [payload.id]: { label: payload.label ?? "", role: payload.role } }));
    void reloadAvailableSensors();
  }

  function bindingRow(binding: ProjectSensorBindingRow) {
    const draft = draftFor(binding);
    const busy = busyId === binding.id;
    return (
      <div key={binding.id} data-testid={`settings-sensor-binding-${binding.id}`} className="grid gap-2 rounded-md border border-stone-200 p-3 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-2">
          <p className="text-sm font-medium text-stone-950">
            {binding.sensor.name} <span className="text-xs font-normal text-stone-500">({binding.node.name})</span>
          </p>
          <label className="field text-xs">
            Label
            <input
              className="input"
              value={draft.label}
              placeholder={binding.sensor.name}
              onChange={(event) => setDraft(binding.id, { label: event.target.value })}
            />
          </label>
          <label className="field text-xs">
            Role
            <select className="input" value={draft.role} onChange={(event) => setDraft(binding.id, { role: event.target.value })}>
              {PROJECT_SENSOR_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {isDirty(binding) ? (
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void saveDraft(binding)}>
              {busy ? "Saving..." : "Save"}
            </button>
          ) : null}
          {isLinked(binding) ? (
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void unlink(binding)}>
              {busy ? "..." : "Unlink"}
            </button>
          ) : (
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void relink(binding)}>
              {busy ? "..." : "Relink"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-stone-950">Environmental Sensors</h2>

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      {linked.length === 0 ? <p className="text-sm text-stone-600">No sensors linked yet.</p> : <div className="grid gap-2">{linked.map(bindingRow)}</div>}

      <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
        <p className="text-sm font-semibold text-stone-800">Link a sensor</p>
        {loadingSensors ? (
          <p className="text-sm text-stone-600">Loading sensors...</p>
        ) : linkableSensors.length === 0 ? (
          <p className="text-sm text-stone-600">{sensorMessage ?? "Every currently-active sensor is already linked."}</p>
        ) : (
          <div className="grid gap-1">
            {linkableSensors.map((sensor) => (
              <div key={sensor.id} data-testid={`project-sensor-link-${sensor.id}`} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {sensor.name} <span className="text-xs text-stone-500">({sensor.node.name})</span>
                </span>
                <button type="button" className="button-secondary" disabled={busyId === sensor.id} onClick={() => void linkSensor(sensor.id)}>
                  {busyId === sensor.id ? "Linking..." : "Link"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {historical.length > 0 ? (
        <details className="rounded-md border border-stone-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-stone-800">Unlinked / historical ({historical.length})</summary>
          <div className="mt-3 grid gap-2">{historical.map(bindingRow)}</div>
        </details>
      ) : null}
    </div>
  );
}
