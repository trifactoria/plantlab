"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toDateTimeLocal } from "@/lib/format";

type GridPlant = {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
};

type ProjectGrid = {
  id: string;
  gridWidth: number;
  gridHeight: number;
};

type SelectedCell = {
  gridX: number;
  gridY: number;
};

type SelectedPlant = {
  id: string;
  name: string;
};

const EVENT_TYPES = [
  "Germinated",
  "Cotyledons",
  "First True Leaf",
  "Harvest Ready",
  "Harvested",
];

export function PlantGrid({
  project,
  plants,
  mode = "dashboard",
  photoId,
  photoTimestamp,
}: {
  project: ProjectGrid;
  plants: GridPlant[];
  mode?: "dashboard" | "photo";
  photoId?: string;
  photoTimestamp?: string;
}) {
  const router = useRouter();
  const plantByCell = useMemo(() => {
    return new Map(plants.map((plant) => [`${plant.gridX}:${plant.gridY}`, plant]));
  }, [plants]);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [selectedPlant, setSelectedPlant] = useState<SelectedPlant | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createPlant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedCell) {
      return;
    }

    setSaving(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/plants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        gridX: selectedCell.gridX,
        gridY: selectedCell.gridY,
        name: formData.get("name"),
        tags: formData.get("tags"),
        notes: formData.get("notes"),
      }),
    });

    const payload = (await response.json()) as { error?: string };
    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not create plant");
      return;
    }

    setSelectedCell(null);
    router.refresh();
  }

  async function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedPlant) {
      return;
    }

    setSaving(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    const timestamp = String(formData.get("timestamp"));
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plantId: selectedPlant.id,
        photoId,
        type: formData.get("type"),
        notes: formData.get("notes"),
        timestamp: new Date(timestamp).toISOString(),
      }),
    });

    const payload = (await response.json()) as { error?: string };
    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not add event");
      return;
    }

    setSelectedPlant(null);
    router.refresh();
  }

  const cells = [];
  for (let y = 0; y < project.gridHeight; y += 1) {
    for (let x = 0; x < project.gridWidth; x += 1) {
      const plant = plantByCell.get(`${x}:${y}`);
      cells.push(
        <div key={`${x}:${y}`} className="aspect-square min-h-16">
          {plant && mode === "dashboard" ? (
            <Link
              href={`/plants/${plant.id}`}
              className="flex h-full w-full items-center justify-center rounded-md border border-emerald-300 bg-emerald-50 p-2 text-center text-sm font-semibold text-emerald-950 transition hover:bg-emerald-100"
            >
              {plant.name}
            </Link>
          ) : (
            <button
              type="button"
              className={`h-full w-full rounded-md border p-2 text-center text-sm font-semibold transition ${
                plant
                  ? "border-cyan-300 bg-cyan-50 text-cyan-950 hover:bg-cyan-100"
                  : mode === "dashboard"
                    ? "border-dashed border-stone-300 bg-white text-stone-400 hover:border-emerald-400 hover:text-emerald-800"
                    : "cursor-default border-dashed border-stone-200 bg-stone-50 text-stone-300"
              }`}
              onClick={() => {
                setError(null);
                if (plant && mode === "photo") {
                  setSelectedPlant(plant);
                  return;
                }

                if (!plant && mode === "dashboard") {
                  setSelectedCell({ gridX: x, gridY: y });
                }
              }}
              disabled={!plant && mode === "photo"}
            >
              {plant ? plant.name : ""}
            </button>
          )}
        </div>,
      );
    }
  }

  return (
    <>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${project.gridWidth}, minmax(0, 1fr))` }}
      >
        {cells}
      </div>

      {selectedCell ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <form onSubmit={createPlant} className="grid w-full max-w-md gap-4 rounded-lg bg-white p-5 shadow-xl">
            <div>
              <h2 className="text-lg font-semibold text-stone-950">Create Plant</h2>
            </div>

            <label className="field">
              Name
              <input className="input" name="name" required autoFocus />
            </label>
            <label className="field">
              Tags
              <input className="input" name="tags" placeholder="fast, control, tray-a" />
            </label>
            <label className="field">
              Notes
              <textarea className="input min-h-24" name="notes" />
            </label>

            {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setSelectedCell(null)}>
                Cancel
              </button>
              <button className="button" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {selectedPlant ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <form onSubmit={addEvent} className="grid w-full max-w-md gap-4 rounded-lg bg-white p-5 shadow-xl">
            <div>
              <h2 className="text-lg font-semibold text-stone-950">Add Event</h2>
              <p className="text-sm text-stone-500">{selectedPlant.name}</p>
            </div>

            <label className="field">
              Event type
              <input className="input" name="type" list="plant-event-types" defaultValue="Germinated" required />
              <datalist id="plant-event-types">
                {EVENT_TYPES.map((eventType) => (
                  <option key={eventType} value={eventType} />
                ))}
              </datalist>
            </label>
            <label className="field">
              Notes
              <textarea className="input min-h-24" name="notes" />
            </label>
            <label className="field">
              Timestamp
              <input
                className="input"
                name="timestamp"
                type="datetime-local"
                defaultValue={photoTimestamp ? toDateTimeLocal(photoTimestamp) : undefined}
                required
              />
            </label>

            {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setSelectedPlant(null)}>
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
