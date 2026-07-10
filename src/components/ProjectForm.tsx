"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type ProjectResponse = {
  id: string;
};

export function ProjectForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        description: formData.get("description"),
        gridWidth: formData.get("gridWidth"),
        gridHeight: formData.get("gridHeight"),
        photoIntervalMinutes: formData.get("photoIntervalMinutes"),
        localPhotoDirectory: formData.get("localPhotoDirectory"),
      }),
    });

    const payload = (await response.json()) as ProjectResponse & { error?: string };

    if (!response.ok) {
      setSaving(false);
      setError(payload.error ?? "Could not create project");
      return;
    }

    router.push(`/projects/${payload.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <label className="field">
        Name
        <input className="input" name="name" placeholder="Radish Speed Test" required />
      </label>

      <label className="field">
        Description
        <textarea className="input min-h-24" name="description" />
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="field">
          Grid width
          <input className="input" name="gridWidth" type="number" min="1" defaultValue="3" required />
        </label>
        <label className="field">
          Grid height
          <input className="input" name="gridHeight" type="number" min="1" defaultValue="6" required />
        </label>
        <label className="field">
          Photo interval
          <input className="input" name="photoIntervalMinutes" type="number" min="1" defaultValue="30" required />
        </label>
      </div>

      <label className="field">
        Local photo directory
        <input className="input" name="localPhotoDirectory" placeholder="/home/andy/plant-photos/radish" required />
      </label>

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      <button className="button w-fit" disabled={saving}>
        {saving ? "Saving..." : "Create Project"}
      </button>
    </form>
  );
}
