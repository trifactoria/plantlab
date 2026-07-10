"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function PhotoNotesForm({
  photoId,
  notes,
}: {
  photoId: string;
  notes: string | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    const formData = new FormData(event.currentTarget);
    await fetch(`/api/photos/${photoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: formData.get("notes") }),
    });

    setSaving(false);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <label className="field">
        Notes
        <textarea className="input min-h-28" name="notes" defaultValue={notes ?? ""} />
      </label>
      <button className="button w-fit" disabled={saving}>
        {saving ? "Saving..." : "Save Notes"}
      </button>
    </form>
  );
}
