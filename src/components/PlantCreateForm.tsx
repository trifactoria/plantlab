"use client";

import { useState } from "react";
import { DateTimeField } from "@/components/DateTimeField";
import { StartingObservationField, StartingObservationMilestone } from "@/components/StartingObservationField";
import { TagInput } from "@/components/TagInput";
import { toDateTimeLocal } from "@/lib/format";
import { ObservationMemory, matchMilestoneByLabel, nextSequentialName } from "@/lib/plantEntry";
import { usePlantEntryMemory } from "@/lib/usePlantEntryMemory";

export type CreatedPlant = { id: string; name: string; gridX: number; gridY: number };

/**
 * Creates a Plant ("Added to project") and, only if the user supplies one, a
 * starting biological observation - atomically, in a single POST /api/plants
 * request (see the transaction in src/app/api/plants/route.ts). Shared by
 * the project grid and photo grid dialogs so create-plant logic isn't
 * duplicated between them.
 */
export function PlantCreateForm({
  projectId,
  cell,
  milestones,
  lastCreatedName,
  onCancel,
  onSaved,
}: {
  projectId: string;
  cell: { gridX: number; gridY: number };
  milestones: StartingObservationMilestone[];
  lastCreatedName: string | null;
  onCancel: () => void;
  onSaved: (plant: CreatedPlant, options: { addNext: boolean }) => void;
}) {
  const { memory, remember } = usePlantEntryMemory(projectId);

  const [name, setName] = useState(() => (lastCreatedName ? nextSequentialName(lastCreatedName) ?? "" : ""));
  const [keepTags, setKeepTags] = useState(true);
  const [tags, setTags] = useState(memory?.tags ?? "");
  const [notes, setNotes] = useState("");
  const [startedAt, setStartedAt] = useState(() =>
    toDateTimeLocal(memory?.startedAt ?? new Date().toISOString()),
  );
  const [observation, setObservation] = useState<ObservationMemory>(memory?.observation ?? { kind: "none" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [pendingAddNext, setPendingAddNext] = useState<boolean | null>(null);

  function startingObservationPayload() {
    if (observation.kind === "none") {
      return undefined;
    }
    if (observation.kind === "milestone") {
      return { milestoneId: observation.milestoneId };
    }
    const matched = matchMilestoneByLabel(observation.label, milestones);
    return matched ? { milestoneId: matched.id } : { type: observation.label };
  }

  async function submit(addNext: boolean, confirmWarnings = false) {
    setSaving(true);
    setError(null);

    const startedAtIso = new Date(startedAt).toISOString();
    const startingObservation = startingObservationPayload();

    const response = await fetch("/api/plants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        gridX: cell.gridX,
        gridY: cell.gridY,
        name,
        tags,
        notes,
        startedAt: startedAtIso,
        confirmWarnings,
        ...(startingObservation ? { startingObservation } : {}),
      }),
    });

    if (response.status === 409) {
      const payload = (await response.json()) as { warnings: string[] };
      setSaving(false);
      setWarnings(payload.warnings);
      setPendingAddNext(addNext);
      return;
    }

    const plantPayload = (await response.json()) as CreatedPlant & { error?: string };
    setSaving(false);

    if (!response.ok) {
      setError(plantPayload.error ?? "Could not create plant");
      return;
    }

    remember({
      startedAt: startedAtIso,
      observation,
      tags: keepTags ? tags : "",
    });
    setWarnings(null);
    setPendingAddNext(null);
    onSaved(plantPayload, { addNext });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
      className="grid max-h-[90vh] w-full max-w-md gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
    >
      <div>
        <h2 className="text-lg font-semibold text-stone-950">Create Plant</h2>
      </div>

      <label className="field">
        Name
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoFocus
        />
      </label>

      <div className="grid gap-1.5">
        <TagInput value={tags} onChange={setTags} />
        <label className="flex items-center gap-2 text-xs font-medium text-stone-600">
          <input type="checkbox" checked={keepTags} onChange={(event) => setKeepTags(event.target.checked)} />
          Reuse these tags for the next plant in this project
        </label>
      </div>

      <label className="field">
        Notes
        <textarea className="input min-h-24" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <StartingObservationField milestones={milestones} value={observation} onChange={setObservation} />

      <DateTimeField label="Starting timestamp" value={startedAt} onChange={setStartedAt} required />

      {warnings ? (
        <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <button
            type="button"
            className="button-secondary w-fit"
            onClick={() => pendingAddNext !== null && submit(pendingAddNext, true)}
            disabled={saving}
          >
            Save Anyway
          </button>
        </div>
      ) : null}

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-secondary" disabled={saving} onClick={() => submit(true)}>
          {saving ? "Saving..." : "Save and add next"}
        </button>
        <button className="button" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}
