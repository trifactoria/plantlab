"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";

export function PlantEditor({
  plantId,
  projectId,
  name,
  tags,
  notes,
  eventCount,
}: {
  plantId: string;
  projectId: string;
  name: string;
  tags: string | null;
  notes: string | null;
  eventCount: number;
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
    const response = await fetch(`/api/plants/${plantId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        tags: formData.get("tags"),
        notes: formData.get("notes"),
      }),
    });
    const payload = (await response.json()) as { error?: string };

    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not update plant");
      return;
    }

    router.refresh();
  }

  async function deletePlant() {
    setDeleting(true);
    setError(null);

    const response = await fetch(`/api/plants/${plantId}`, { method: "DELETE" });
    const payload = (await response.json()) as { error?: string };

    setDeleting(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not delete plant");
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
          Name
          <input className="input" name="name" defaultValue={name} required />
        </label>
        <label className="field">
          Tags
          <input className="input" name="tags" defaultValue={tags ?? ""} />
        </label>
        <label className="field">
          Notes
          <textarea className="input min-h-28" name="notes" defaultValue={notes ?? ""} />
        </label>

        {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

        <button className="button w-fit" disabled={saving}>
          {saving ? "Saving..." : "Save Plant"}
        </button>
      </form>

      <div className="border-t border-stone-200 pt-4">
        <ConfirmActionButton
          title="Delete Plant"
          message={`Delete this plant? ${eventCount} event${eventCount === 1 ? "" : "s"} will also be deleted.`}
          confirmLabel="Delete Plant"
          onConfirm={deletePlant}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete Plant"}
        </ConfirmActionButton>
      </div>
    </div>
  );
}
