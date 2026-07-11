"use client";

import { useState } from "react";
import { DateTimeField } from "@/components/DateTimeField";
import { StartingObservationField, StartingObservationMilestone } from "@/components/StartingObservationField";
import { TagInput } from "@/components/TagInput";
import { toDateTimeLocal } from "@/lib/format";
import { ObservationMemory, matchMilestoneByLabel, nextSequentialName } from "@/lib/plantEntry";
import { usePlantEntryMemory } from "@/lib/usePlantEntryMemory";

export type CreatedPlant = { id: string; name: string; gridX: number; gridY: number };

type PendingSave = {
  plant: CreatedPlant;
  addNext: boolean;
  startedAtIso: string;
};

type ObservationEventResult = { ok: true } | { ok: false; warnings: string[] } | { ok: false; error: string };

/**
 * Creates a Plant record ("Added to project") and, only if the user supplies
 * one, a separate starting-observation PlantEvent. Shared by the project grid
 * and photo grid dialogs so create-plant logic isn't duplicated between them.
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
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);

  async function createObservationEvent(
    plantId: string,
    startedAtIso: string,
    confirmWarnings: boolean,
  ): Promise<ObservationEventResult> {
    const matchedMilestone =
      observation.kind === "custom" ? matchMilestoneByLabel(observation.label, milestones) : undefined;

    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plantId,
        timestamp: startedAtIso,
        confirmWarnings,
        ...(observation.kind === "milestone"
          ? { milestoneId: observation.milestoneId }
          : { milestoneId: matchedMilestone?.id, type: observation.kind === "custom" ? observation.label : undefined }),
      }),
    });

    if (response.status === 409) {
      const payload = (await response.json()) as { warnings: string[] };
      return { ok: false as const, warnings: payload.warnings };
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false as const, error: payload.error ?? "Could not save the starting observation." };
    }

    return { ok: true as const };
  }

  function finishSave(plant: CreatedPlant, addNext: boolean, startedAtIso: string) {
    remember({
      startedAt: startedAtIso,
      observation,
      tags: keepTags ? tags : "",
    });
    setSaving(false);
    setWarnings(null);
    setPendingSave(null);
    onSaved(plant, { addNext });
  }

  async function submit(addNext: boolean) {
    setSaving(true);
    setError(null);
    setWarnings(null);

    const startedAtIso = new Date(startedAt).toISOString();

    const plantResponse = await fetch("/api/plants", {
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
      }),
    });
    const plantPayload = (await plantResponse.json()) as CreatedPlant & { error?: string };

    if (!plantResponse.ok) {
      setSaving(false);
      setError(plantPayload.error ?? "Could not create plant");
      return;
    }

    if (observation.kind === "none") {
      finishSave(plantPayload, addNext, startedAtIso);
      return;
    }

    const result = await createObservationEvent(plantPayload.id, startedAtIso, false);
    if (!result.ok) {
      setSaving(false);
      if ("warnings" in result) {
        setWarnings(result.warnings);
        setPendingSave({ plant: plantPayload, addNext, startedAtIso });
        return;
      }
      setError(result.error);
      return;
    }

    finishSave(plantPayload, addNext, startedAtIso);
  }

  async function confirmPendingSave() {
    if (!pendingSave) {
      return;
    }
    setSaving(true);
    const result = await createObservationEvent(pendingSave.plant.id, pendingSave.startedAtIso, true);
    if (!result.ok) {
      setSaving(false);
      setError("error" in result ? result.error : "Could not save the starting observation.");
      return;
    }
    finishSave(pendingSave.plant, pendingSave.addNext, pendingSave.startedAtIso);
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
          <button type="button" className="button-secondary w-fit" onClick={confirmPendingSave} disabled={saving}>
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
