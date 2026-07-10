"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { CropSelector, type CropValue } from "@/components/CropSelector";
import { toDateTimeLocal } from "@/lib/format";

type EditableEvent = {
  id: string;
  type: string;
  notes: string | null;
  timestamp: string;
  photoId: string | null;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
};

export function EventActions({ event }: { event: EditableEvent }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialCrop =
    event.cropX !== null &&
    event.cropY !== null &&
    event.cropWidth !== null &&
    event.cropHeight !== null
      ? {
          cropX: event.cropX,
          cropY: event.cropY,
          cropWidth: event.cropWidth,
          cropHeight: event.cropHeight,
        }
      : null;
  const [crop, setCrop] = useState<CropValue | null>(initialCrop);
  const [showCropSelector, setShowCropSelector] = useState(Boolean(initialCrop));

  async function save(updatedEvent: FormEvent<HTMLFormElement>) {
    updatedEvent.preventDefault();
    setSaving(true);
    setError(null);

    const formData = new FormData(updatedEvent.currentTarget);
    const timestamp = String(formData.get("timestamp"));
    const keepPhotoLink = formData.get("keepPhotoLink") === "on";
    const nextPhotoId = event.photoId ? (keepPhotoLink ? event.photoId : null) : undefined;
    const response = await fetch(`/api/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: formData.get("type"),
        notes: formData.get("notes"),
        timestamp: new Date(timestamp).toISOString(),
        photoId: nextPhotoId,
        ...(nextPhotoId === null
          ? { cropX: null, cropY: null, cropWidth: null, cropHeight: null }
          : crop ?? { cropX: null, cropY: null, cropWidth: null, cropHeight: null }),
      }),
    });
    const payload = (await response.json()) as { error?: string };

    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not update event");
      return;
    }

    setEditing(false);
    router.refresh();
  }

  async function deleteEvent() {
    setDeleting(true);
    setError(null);

    const response = await fetch(`/api/events/${event.id}`, { method: "DELETE" });
    const payload = (await response.json()) as { error?: string };

    setDeleting(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not delete event");
      return false;
    }

    router.refresh();
    return true;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            setError(null);
            setEditing(true);
          }}
        >
          Edit
        </button>
        <ConfirmActionButton
          title="Delete Event"
          message="Delete this event? Only this event will be removed."
          confirmLabel="Delete Event"
          onConfirm={deleteEvent}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete"}
        </ConfirmActionButton>
      </div>
      {error ? <p className="mt-2 text-sm font-medium text-red-700">{error}</p> : null}

      {editing ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <form
            onSubmit={save}
            className="grid max-h-[90vh] w-full max-w-md gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
          >
            <div>
              <h2 className="text-lg font-semibold text-stone-950">Edit Event</h2>
            </div>

            <label className="field">
              Event type
              <input className="input" name="type" defaultValue={event.type} required autoFocus />
            </label>
            <label className="field">
              Notes
              <textarea className="input min-h-24" name="notes" defaultValue={event.notes ?? ""} />
            </label>
            <label className="field">
              Timestamp
              <input
                className="input"
                name="timestamp"
                type="datetime-local"
                defaultValue={toDateTimeLocal(event.timestamp)}
                required
              />
            </label>
            {event.photoId ? (
              <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
                <input name="keepPhotoLink" type="checkbox" defaultChecked />
                Keep linked photo
              </label>
            ) : null}
            {event.photoId ? (
              <div className="grid gap-3">
                <button
                  type="button"
                  className="button-secondary w-fit"
                  onClick={() => setShowCropSelector((value) => !value)}
                >
                  Select crop from photo
                </button>
                {showCropSelector ? (
                  <CropSelector
                    imageUrl={`/api/photos/${event.photoId}/file`}
                    value={crop}
                    onChange={setCrop}
                  />
                ) : null}
              </div>
            ) : null}

            {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="button" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
