"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { toDateTimeLocal } from "@/lib/format";

export type HarvestResultValue = {
  harvestedAt: string;
  rootWeightGrams: number | null;
  rootDiameterMm: number | null;
  rootLengthMm: number | null;
  split: boolean;
  bolted: boolean;
  damaged: boolean;
  acceptable: boolean;
  flavorScore: number | null;
  selectedForSeed: boolean;
  notes: string | null;
};

export function PlantHarvestResultForm({
  plantId,
  initialResult,
  defaultHarvestedAt,
}: {
  plantId: string;
  initialResult: HarvestResultValue | null;
  defaultHarvestedAt: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(Boolean(initialResult));
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitPayload(payload: Record<string, unknown>, confirmWarnings = false) {
    setSaving(true);
    setWarnings(null);
    setMessage(null);
    setError(null);

    const response = await fetch(`/api/plants/${plantId}/harvest-result`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirmWarnings }),
    });
    const body = (await response.json()) as { warnings?: string[]; error?: string };
    setSaving(false);

    if (response.status === 409 && body.warnings) {
      setWarnings(body.warnings);
      setPendingPayload(payload);
      return;
    }

    if (!response.ok) {
      setError(body.error ?? "Could not save harvest result.");
      return;
    }

    setMessage("Harvest result saved.");
    setPendingPayload(null);
    router.refresh();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await submitPayload({
      harvestedAt: new Date(String(formData.get("harvestedAt"))).toISOString(),
      rootWeightGrams: formData.get("rootWeightGrams"),
      rootDiameterMm: formData.get("rootDiameterMm"),
      rootLengthMm: formData.get("rootLengthMm"),
      split: formData.get("split") === "on",
      bolted: formData.get("bolted") === "on",
      damaged: formData.get("damaged") === "on",
      acceptable: formData.get("acceptable") === "on",
      flavorScore: formData.get("flavorScore"),
      selectedForSeed: formData.get("selectedForSeed") === "on",
      notes: formData.get("notes"),
    });
  }

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-950">Harvest Result</h2>
        <button type="button" className="button-secondary" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Hide Form" : initialResult ? "Edit Result" : "Add Result"}
        </button>
      </div>

      {expanded ? (
        <form onSubmit={save} className="mt-4 grid gap-3">
          <label className="field">
            Harvested at
            <input
              className="input"
              name="harvestedAt"
              type="datetime-local"
              defaultValue={toDateTimeLocal(initialResult?.harvestedAt ?? defaultHarvestedAt)}
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="field">
              Root weight grams
              <input className="input" name="rootWeightGrams" type="number" step="0.1" defaultValue={initialResult?.rootWeightGrams ?? ""} />
            </label>
            <label className="field">
              Root diameter mm
              <input className="input" name="rootDiameterMm" type="number" step="0.1" defaultValue={initialResult?.rootDiameterMm ?? ""} />
            </label>
            <label className="field">
              Root length mm
              <input className="input" name="rootLengthMm" type="number" step="0.1" defaultValue={initialResult?.rootLengthMm ?? ""} />
            </label>
          </div>
          <div className="flex flex-wrap gap-3 text-sm font-medium text-stone-800">
            {[
              ["acceptable", "Acceptable", initialResult?.acceptable ?? true],
              ["split", "Split", initialResult?.split ?? false],
              ["bolted", "Bolted", initialResult?.bolted ?? false],
              ["damaged", "Damaged", initialResult?.damaged ?? false],
              ["selectedForSeed", "Selected for seed", initialResult?.selectedForSeed ?? false],
            ].map(([name, label, checked]) => (
              <label key={String(name)} className="flex items-center gap-2">
                <input name={String(name)} type="checkbox" defaultChecked={Boolean(checked)} />
                {String(label)}
              </label>
            ))}
          </div>
          <label className="field">
            Flavor score
            <input className="input" name="flavorScore" type="number" min="1" max="10" defaultValue={initialResult?.flavorScore ?? ""} />
          </label>
          <label className="field">
            Notes
            <textarea className="input min-h-20" name="notes" defaultValue={initialResult?.notes ?? ""} />
          </label>

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
          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
          <button className="button w-fit" disabled={saving}>
            {saving ? "Saving..." : "Save Harvest Result"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
