"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export type EditableMilestone = {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  enabled: boolean;
};

export function ProjectMilestoneSettings({
  projectId,
  initialMilestones,
}: {
  projectId: string;
  initialMilestones: EditableMilestone[];
}) {
  const router = useRouter();
  const [milestones, setMilestones] = useState(initialMilestones);
  const [customLabel, setCustomLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateLocal(id: string, patch: Partial<EditableMilestone>) {
    setMilestones((current) =>
      current.map((milestone) => (milestone.id === id ? { ...milestone, ...patch } : milestone)),
    );
  }

  async function saveMilestone(milestone: EditableMilestone) {
    setMessage(null);
    setError(null);
    const response = await fetch(`/api/project-milestones/${milestone.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: milestone.label,
        sortOrder: milestone.sortOrder,
        enabled: milestone.enabled,
      }),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Could not save milestone.");
      return;
    }
    setMessage("Milestone saved.");
    router.refresh();
  }

  async function addCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    const response = await fetch("/api/project-milestones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, label: customLabel }),
    });
    const payload = (await response.json()) as EditableMilestone & { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Could not add milestone.");
      return;
    }
    setMilestones((current) => [...current, payload].sort((a, b) => a.sortOrder - b.sortOrder));
    setCustomLabel("");
    setMessage("Custom milestone added.");
    router.refresh();
  }

  async function associateExisting() {
    setMessage(null);
    setError(null);
    const response = await fetch("/api/project-milestones", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, associateExactLabels: true }),
    });
    const payload = (await response.json()) as { updatedCount?: number; error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Could not associate existing events.");
      return;
    }
    setMessage(`Associated ${payload.updatedCount ?? 0} existing exact-label event(s).`);
    router.refresh();
  }

  return (
    <section data-testid="project-milestone-settings" className="grid gap-4 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold text-stone-950">Milestones</h2>
        <p className="mt-1 text-sm text-stone-600">
          Labels are editable. Keys stay stable once events use them.
        </p>
      </div>

      <div className="grid gap-2">
        {milestones.map((milestone) => (
          <div key={milestone.id} className="grid gap-2 rounded-md border border-stone-200 p-3 sm:grid-cols-[1fr_90px_auto_auto] sm:items-end">
            <label className="field">
              Label
              <input
                className="input"
                value={milestone.label}
                onChange={(event) => updateLocal(milestone.id, { label: event.target.value })}
              />
            </label>
            <label className="field">
              Order
              <input
                className="input"
                type="number"
                min="1"
                value={milestone.sortOrder}
                onChange={(event) =>
                  updateLocal(milestone.id, { sortOrder: Number.parseInt(event.target.value, 10) || 1 })
                }
              />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm font-medium text-stone-800">
              <input
                type="checkbox"
                checked={milestone.enabled}
                onChange={(event) => updateLocal(milestone.id, { enabled: event.target.checked })}
              />
              Enabled
            </label>
            <button type="button" className="button-secondary" onClick={() => saveMilestone(milestone)}>
              Save
            </button>
            <p className="font-mono text-xs text-stone-500 sm:col-span-4">{milestone.key}</p>
          </div>
        ))}
      </div>

      <form onSubmit={addCustom} className="flex flex-wrap items-end gap-2 border-t border-stone-200 pt-4">
        <label className="field min-w-64">
          Custom milestone
          <input
            className="input"
            value={customLabel}
            onChange={(event) => setCustomLabel(event.target.value)}
            placeholder="Flowering"
            required
          />
        </label>
        <button className="button-secondary">Add Milestone</button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="button-secondary" onClick={associateExisting}>
          Associate Existing Exact Labels
        </button>
        <span className="text-xs text-stone-500">Optional, non-destructive compatibility helper.</span>
      </div>

      {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
    </section>
  );
}
