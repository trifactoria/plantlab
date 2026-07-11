"use client";

import { useState } from "react";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { CropSelector, type CropValue } from "@/components/CropSelector";
import { DateTimeField } from "@/components/DateTimeField";
import { StartingObservationField, StartingObservationMilestone } from "@/components/StartingObservationField";
import { toDateTimeLocal } from "@/lib/format";
import { ORIGIN_EVENT_TYPE, isOriginEvent } from "@/lib/observationKinds";
import { ObservationMemory, matchMilestoneByLabel } from "@/lib/plantEntry";
import {
  PlantEventResponse,
  createObservation,
  deleteObservation,
  updateObservation,
} from "@/lib/observationClient";

export type ObservationFormEvent = {
  id: string;
  kind: string;
  type: string;
  notes: string | null;
  timestamp: string;
  photoId: string | null;
  milestoneId: string | null;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
};

/**
 * One reusable create/edit form for a PlantEvent ("observation" in the UI).
 * Used by Add Event, Quick Milestone, and editing any existing timeline
 * entry, including the plant's origin event (in a read-mostly mode - see
 * isOrigin below). Keeping this as the single implementation is what lets
 * Add Event/Quick Milestone/edit all share one mutation path.
 */
export function ObservationForm({
  plantId,
  milestones,
  event,
  photoId,
  photoTimestamp,
  copyPlantPhotoCrop = false,
  title,
  onCancel,
  onSaved,
  onDeleted,
}: {
  plantId: string;
  milestones: StartingObservationMilestone[];
  event?: ObservationFormEvent | null;
  photoId?: string;
  photoTimestamp?: string;
  /** Create mode only: default the new event's crop to the plant's saved PlantPhotoCrop for this photo, unless the user manually picks one below. */
  copyPlantPhotoCrop?: boolean;
  title?: string;
  onCancel: () => void;
  onSaved: (event: PlantEventResponse) => void;
  onDeleted?: () => void;
}) {
  const isEdit = Boolean(event);
  const isOrigin = Boolean(event && isOriginEvent(event));
  // In create mode, an ambient photoId (opened from a photo's grid/quick
  // entry) is always linked, matching prior Add Event/Quick Milestone
  // behavior. In edit mode, the existing event's own photo link is what's
  // editable via the "Keep linked photo" checkbox below.
  const effectivePhotoId = isEdit ? (event?.photoId ?? null) : (photoId ?? null);

  const initialObservation: ObservationMemory = event
    ? event.milestoneId
      ? { kind: "milestone", milestoneId: event.milestoneId, label: event.type }
      : { kind: "custom", label: event.type }
    : { kind: "none" };

  const [observation, setObservation] = useState<ObservationMemory>(initialObservation);
  const [timestamp, setTimestamp] = useState(() =>
    toDateTimeLocal(event?.timestamp ?? photoTimestamp ?? new Date().toISOString()),
  );
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [keepPhotoLink, setKeepPhotoLink] = useState(true);
  const initialCrop: CropValue | null =
    event?.cropX !== undefined &&
    event?.cropX !== null &&
    event?.cropY !== null &&
    event?.cropWidth !== null &&
    event?.cropHeight !== null
      ? {
          cropX: event!.cropX as number,
          cropY: event!.cropY as number,
          cropWidth: event!.cropWidth as number,
          cropHeight: event!.cropHeight as number,
        }
      : null;
  const [crop, setCrop] = useState<CropValue | null>(initialCrop);
  const [showCropSelector, setShowCropSelector] = useState(Boolean(initialCrop));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);

  function observationPayload() {
    const matchedMilestone =
      observation.kind === "custom" ? matchMilestoneByLabel(observation.label, milestones) : undefined;

    if (observation.kind === "milestone") {
      return { milestoneId: observation.milestoneId };
    }

    if (matchedMilestone) {
      return { milestoneId: matchedMilestone.id };
    }

    // Explicit null clears any milestone link this event previously had
    // (e.g. converting a milestone event to a custom observation).
    return { milestoneId: isEdit ? null : undefined, type: observation.kind === "custom" ? observation.label : "" };
  }

  function buildPayload() {
    const timestampIso = new Date(timestamp).toISOString();

    if (isOrigin) {
      return { timestamp: timestampIso, notes: notes.trim() ? notes : null };
    }

    if (isEdit) {
      const nextPhotoId = event?.photoId ? (keepPhotoLink ? event.photoId : null) : undefined;
      const cropFields =
        nextPhotoId === null
          ? { cropX: null, cropY: null, cropWidth: null, cropHeight: null }
          : crop ?? { cropX: null, cropY: null, cropWidth: null, cropHeight: null };

      return {
        photoId: nextPhotoId,
        timestamp: timestampIso,
        notes: notes.trim() ? notes : null,
        ...observationPayload(),
        ...cropFields,
      };
    }

    return {
      plantId,
      photoId: effectivePhotoId ?? undefined,
      timestamp: timestampIso,
      notes: notes.trim() ? notes : null,
      ...observationPayload(),
      ...(effectivePhotoId ? (crop ?? { cropX: null, cropY: null, cropWidth: null, cropHeight: null }) : {}),
      ...(effectivePhotoId && !crop && copyPlantPhotoCrop ? { copyPlantPhotoCrop: true } : {}),
    };
  }

  async function save(confirmWarnings = false) {
    if (!isOrigin && observation.kind === "none") {
      setError("Select a milestone or enter a custom observation.");
      return;
    }

    setSaving(true);
    setError(null);
    setWarnings(null);

    const payload = buildPayload();
    const result = isEdit
      ? await updateObservation(event!.id, payload, confirmWarnings)
      : await createObservation(payload, confirmWarnings);

    setSaving(false);

    if (!result.ok) {
      if ("warnings" in result) {
        setWarnings(result.warnings);
        setPendingConfirm(true);
        return;
      }
      setError(result.error);
      return;
    }

    setWarnings(null);
    setPendingConfirm(false);
    onSaved(result.data);
  }

  async function handleDelete() {
    if (!event) {
      return false;
    }
    setDeleting(true);
    setError(null);
    const result = await deleteObservation(event.id);
    setDeleting(false);

    if (!result.ok) {
      setError(result.error);
      return false;
    }

    onDeleted?.();
    return true;
  }

  return (
    <div
      data-testid="observation-form"
      className="grid max-h-[90vh] w-full max-w-md gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
    >
      <div>
        <h2 className="text-lg font-semibold text-stone-950">
          {title ?? (isOrigin ? "Origin Event" : isEdit ? "Edit Event" : "Add Event")}
        </h2>
        {isOrigin ? (
          <p className="mt-1 text-sm text-stone-500">
            This is the plant&apos;s &quot;{ORIGIN_EVENT_TYPE}&quot; record. Its timestamp and notes can be
            edited; it can&apos;t be deleted or converted into an observation.
          </p>
        ) : null}
      </div>

      {isOrigin ? null : (
        <StartingObservationField
          milestones={milestones}
          value={observation}
          onChange={setObservation}
          label="Observation"
          helpText={null}
        />
      )}

      <DateTimeField label="Timestamp" value={timestamp} onChange={setTimestamp} required />

      <label className="field">
        Notes
        <textarea className="input min-h-24" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      {!isOrigin && effectivePhotoId ? (
        <div className="grid gap-3">
          {isEdit ? (
            <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
              <input
                type="checkbox"
                checked={keepPhotoLink}
                onChange={(event) => setKeepPhotoLink(event.target.checked)}
              />
              Keep linked photo
            </label>
          ) : null}
          {!isEdit || keepPhotoLink ? (
            <>
              <button
                type="button"
                className="button-secondary w-fit"
                onClick={() => setShowCropSelector((value) => !value)}
              >
                Select crop from photo
              </button>
              {showCropSelector ? (
                <CropSelector imageUrl={`/api/photos/${effectivePhotoId}/file`} value={crop} onChange={setCrop} />
              ) : null}
            </>
          ) : null}
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
            onClick={() => pendingConfirm && save(true)}
            disabled={saving}
          >
            Save Anyway
          </button>
        </div>
      ) : null}

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {isEdit && !isOrigin ? (
          <ConfirmActionButton
            title="Delete Event"
            message="Delete this event? Only this event will be removed."
            confirmLabel="Delete Event"
            onConfirm={handleDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </ConfirmActionButton>
        ) : (
          <span />
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button" disabled={saving} onClick={() => save(false)}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
