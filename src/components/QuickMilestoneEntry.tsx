"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CropSelector, type CropValue } from "@/components/CropSelector";
import { toDateTimeLocal } from "@/lib/format";

export type QuickMilestone = {
  id: string;
  key: string;
  label: string;
};

export type QuickPlant = {
  id: string;
  name: string;
};

export type ExistingMilestone = {
  plantId: string;
  milestoneId: string | null;
};

export function QuickMilestoneEntry({
  plants,
  milestones,
  photoId,
  photoTimestamp,
  imageUrl,
  existingMilestones,
  cropByPlantId = {},
  fixedPlantId,
  compact = false,
  onSaved,
}: {
  plants: QuickPlant[];
  milestones: QuickMilestone[];
  photoId: string;
  photoTimestamp: string;
  imageUrl: string;
  existingMilestones: ExistingMilestone[];
  cropByPlantId?: Record<string, CropValue | null>;
  fixedPlantId?: string;
  compact?: boolean;
  onSaved?: () => Promise<void> | void;
}) {
  const router = useRouter();
  const [plantId, setPlantId] = useState(fixedPlantId ?? plants[0]?.id ?? "");
  const [showMore, setShowMore] = useState(false);
  const [timestamp, setTimestamp] = useState(toDateTimeLocal(photoTimestamp));
  const [notes, setNotes] = useState("");
  const [customType, setCustomType] = useState("");
  const [adjustCrop, setAdjustCrop] = useState(false);
  const [crop, setCrop] = useState<CropValue | null>(plantId ? cropByPlantId[plantId] ?? null : null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [harvestPromptPlantId, setHarvestPromptPlantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedPlant = plants.find((plant) => plant.id === plantId);
  const completed = new Set(
    existingMilestones
      .filter((event) => event.plantId === plantId && event.milestoneId)
      .map((event) => event.milestoneId),
  );

  function selectPlant(nextPlantId: string) {
    setPlantId(nextPlantId);
    setCrop(cropByPlantId[nextPlantId] ?? null);
    setWarnings(null);
    setPendingPayload(null);
  }

  async function submitPayload(payload: Record<string, unknown>, confirmWarnings = false) {
    setSavingId(String(payload.milestoneId ?? "custom"));
    setMessage(null);
    setError(null);
    setWarnings(null);

    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirmWarnings }),
    });
    const body = (await response.json()) as { warnings?: string[]; error?: string };
    setSavingId(null);

    if (response.status === 409 && body.warnings) {
      setWarnings(body.warnings);
      setPendingPayload(payload);
      return;
    }

    if (!response.ok) {
      setError(body.error ?? "Could not save event.");
      return;
    }

    setMessage("Event saved.");
    setHarvestPromptPlantId(payload.milestoneKey === "harvested" ? String(payload.plantId) : null);
    setNotes("");
    setCustomType("");
    setWarnings(null);
    setPendingPayload(null);
    await onSaved?.();
    router.refresh();
  }

  function eventPayload(milestone?: QuickMilestone) {
    if (!plantId) {
      return null;
    }

    return {
      plantId,
      photoId,
      milestoneId: milestone?.id,
      milestoneKey: milestone?.key,
      type: milestone ? milestone.label : customType,
      notes,
      timestamp: new Date(timestamp).toISOString(),
      ...(adjustCrop && crop ? crop : { copyPlantPhotoCrop: true }),
    };
  }

  async function saveMilestone(milestone: QuickMilestone) {
    const payload = eventPayload(milestone);
    if (!payload) {
      return;
    }
    await submitPayload(payload);
  }

  async function saveCustom() {
    const payload = eventPayload();
    if (!payload || !customType.trim()) {
      return;
    }
    await submitPayload(payload);
  }

  return (
    <div data-testid="quick-milestone-entry" className={`grid gap-3 rounded-lg border border-stone-200 bg-white ${compact ? "p-3" : "p-5"} shadow-sm`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className={compact ? "text-sm font-semibold text-stone-950" : "text-lg font-semibold text-stone-950"}>
            Quick Milestone Entry
          </h2>
          {selectedPlant ? <p className="text-xs text-stone-500">{selectedPlant.name}</p> : null}
        </div>
        {!fixedPlantId ? (
          <label className="field min-w-48">
            Plant
            <select className="input" value={plantId} onChange={(event) => selectPlant(event.target.value)}>
              {plants.map((plant) => (
                <option key={plant.id} value={plant.id}>
                  {plant.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {milestones.map((milestone) => {
          const duplicate = completed.has(milestone.id);
          return (
            <button
              key={milestone.id}
              type="button"
              className={duplicate ? "button-secondary opacity-70" : "button-secondary"}
              onClick={() => saveMilestone(milestone)}
              disabled={!plantId || savingId === milestone.id}
              title={duplicate ? "This plant already has this milestone; saving again requires confirmation." : undefined}
            >
              {savingId === milestone.id ? "Saving..." : milestone.label}
              {duplicate ? " (recorded)" : ""}
            </button>
          );
        })}
      </div>

      <button type="button" className="button-secondary w-fit" onClick={() => setShowMore((value) => !value)}>
        More options
      </button>

      {showMore ? (
        <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
          <label className="field">
            Timestamp
            <input
              className="input"
              type="datetime-local"
              value={timestamp}
              onChange={(event) => setTimestamp(event.target.value)}
            />
          </label>
          <label className="field">
            Notes
            <textarea className="input min-h-20" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="field min-w-52">
              Custom event
              <input className="input" value={customType} onChange={(event) => setCustomType(event.target.value)} />
            </label>
            <button type="button" className="button-secondary" onClick={saveCustom} disabled={!customType.trim()}>
              Save Custom
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
            <input type="checkbox" checked={adjustCrop} onChange={(event) => setAdjustCrop(event.target.checked)} />
            Adjust event crop before save
          </label>
          {adjustCrop ? <CropSelector imageUrl={imageUrl} value={crop} onChange={setCrop} /> : null}
        </div>
      ) : null}

      {warnings ? (
        <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <button
            type="button"
            className="button-secondary w-fit"
            onClick={() => pendingPayload && submitPayload(pendingPayload, true)}
          >
            Save Anyway
          </button>
        </div>
      ) : null}

      {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}
      {harvestPromptPlantId ? (
        <p className="text-sm text-stone-700">
          Harvested milestone saved.{" "}
          <Link href={`/plants/${harvestPromptPlantId}`} className="font-semibold text-emerald-700">
            Open harvest result form
          </Link>
          .
        </p>
      ) : null}
      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
    </div>
  );
}
