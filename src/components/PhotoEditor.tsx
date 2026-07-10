"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { toDateTimeLocal } from "@/lib/format";

export function PhotoEditor({
  photoId,
  projectId,
  timestamp,
  notes,
}: {
  photoId: string;
  projectId: string;
  timestamp: string;
  notes: string | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const nextTimestamp = String(formData.get("timestamp"));
    const response = await fetch(`/api/photos/${photoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date(nextTimestamp).toISOString(),
        notes: formData.get("notes"),
      }),
    });
    const payload = (await response.json()) as { error?: string };

    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not update photo");
      return;
    }

    router.refresh();
  }

  async function deletePhoto() {
    setDeleting(true);
    setError(null);

    const response = await fetch(`/api/photos/${photoId}`, { method: "DELETE" });
    const payload = (await response.json()) as { error?: string };

    setDeleting(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not delete photo");
      return false;
    }

    router.push(`/projects/${projectId}`);
    router.refresh();
    return true;
  }

  return (
    <div className="grid gap-4">
      <form onSubmit={save} className="grid gap-3">
        <label className="field">
          Timestamp
          <input
            className="input"
            name="timestamp"
            type="datetime-local"
            defaultValue={toDateTimeLocal(timestamp)}
            required
          />
        </label>
        <label className="field">
          Notes
          <textarea className="input min-h-28" name="notes" defaultValue={notes ?? ""} />
        </label>

        {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

        <button className="button w-fit" disabled={saving}>
          {saving ? "Saving..." : "Save Photo"}
        </button>
      </form>

      <div className="border-t border-stone-200 pt-4">
        <ConfirmActionButton
          title="Delete Photo"
          message="The PlantLab database entry and the local image file will both be removed. Events linked to this photo will remain but lose the photo link."
          confirmLabel="Delete Photo"
          onConfirm={deletePhoto}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete Photo"}
        </ConfirmActionButton>
      </div>
    </div>
  );
}
