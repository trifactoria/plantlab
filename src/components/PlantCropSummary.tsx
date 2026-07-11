"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { PlantCropEditor, type CropValue } from "@/components/PlantCropEditor";
import { type CropShape } from "@/lib/cropGeometry";
import { buildCropThumbnailUrl } from "@/lib/cropThumbnail";

type ProjectPlant = {
  id: string;
  name: string;
  visualAspectRatio: CropShape | null;
};

type ExistingCrop = {
  id: string;
  plantId: string;
  plantName: string;
  updatedAt: string;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  createdMethod: string;
  sourceCropId: string | null;
};

type PropagationTarget = "later-without-crop" | "all-without-crop";
type ApplyTarget = "this-photo-only" | PropagationTarget;

export function PlantCropSummary({
  photoId,
  imageUrl,
  plants,
  crops,
}: {
  photoId: string;
  imageUrl: string;
  plants: ProjectPlant[];
  crops: ExistingCrop[];
}) {
  const router = useRouter();
  const plantsWithoutCrop = plants.filter((plant) => !crops.some((crop) => crop.plantId === plant.id));

  const [addingPlantId, setAddingPlantId] = useState("");
  const [modalPlant, setModalPlant] = useState<{ id: string; name: string; cropId?: string } | null>(null);
  const [modalCrop, setModalCrop] = useState<CropValue | null>(null);
  const [modalAspectRatio, setModalAspectRatio] = useState<CropShape | null>(null);
  const [applyTarget, setApplyTarget] = useState<ApplyTarget>("this-photo-only");
  const [propagationCounts, setPropagationCounts] = useState<
    Partial<Record<PropagationTarget, { affectedCount: number; skippedExistingCount: number }>>
  >({});
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removingCropId, setRemovingCropId] = useState<string | null>(null);

  const [propagateResult, setPropagateResult] = useState<string | null>(null);

  function openEditor(plant: { id: string; name: string; cropId?: string }, crop: CropValue | null) {
    setSaveError(null);
    setApplyTarget("this-photo-only");
    setOverwriteExisting(false);
    setOverwriteConfirmed(false);
    setPropagationCounts({});
    const sourcePlant = plants.find((item) => item.id === plant.id);
    setModalAspectRatio(sourcePlant?.visualAspectRatio ?? null);
    setModalPlant(plant);
    setModalCrop(crop);
    void loadPropagationCounts(plant.id, false);
  }

  function openAddCrop() {
    const plant = plants.find((item) => item.id === addingPlantId);
    if (!plant) {
      return;
    }
    openEditor(plant, null);
  }

  async function loadPropagationCounts(plantId: string, overwrite: boolean) {
    const targets: PropagationTarget[] = ["later-without-crop", "all-without-crop"];
    const counts = await Promise.all(
      targets.map(async (target) => {
        const response = await fetch("/api/plant-photo-crops/propagate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plantId,
            sourcePhotoId: photoId,
            target,
            dryRun: true,
            overwrite,
          }),
        });
        if (!response.ok) {
          return [target, null] as const;
        }
        const payload = (await response.json()) as {
          affectedCount?: number;
          skippedExistingCount?: number;
        };
        return [
          target,
          {
            affectedCount: payload.affectedCount ?? 0,
            skippedExistingCount: payload.skippedExistingCount ?? 0,
          },
        ] as const;
      }),
    );

    setPropagationCounts(
      Object.fromEntries(counts.filter(([, value]) => value !== null)) as Partial<
        Record<PropagationTarget, { affectedCount: number; skippedExistingCount: number }>
      >,
    );
  }

  async function saveCrop() {
    if (!modalPlant || !modalCrop) {
      return;
    }

    if (overwriteExisting && !overwriteConfirmed) {
      setSaveError("Confirm overwriting existing crops before saving.");
      return;
    }

    setSaving(true);
    setSaveError(null);

    const response = await fetch("/api/plant-photo-crops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plantId: modalPlant.id, photoId, ...modalCrop, visualAspectRatio: modalAspectRatio }),
    });
    const payload = (await response.json()) as { id?: string; error?: string };

    if (!response.ok) {
      setSaving(false);
      setSaveError(payload.error ?? "Could not save crop.");
      return;
    }

    let propagatedCount = 0;
    let skippedExistingCount = 0;
    if (applyTarget !== "this-photo-only") {
      const propagateResponse = await fetch("/api/plant-photo-crops/propagate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plantId: modalPlant.id,
          sourcePhotoId: photoId,
          target: applyTarget,
          dryRun: false,
          overwrite: overwriteExisting && overwriteConfirmed,
        }),
      });
      const propagatePayload = (await propagateResponse.json()) as {
        affectedCount?: number;
        skippedExistingCount?: number;
        error?: string;
      };

      if (!propagateResponse.ok) {
        setSaving(false);
        setSaveError(propagatePayload.error ?? "Crop saved, but propagation failed.");
        return;
      }
      propagatedCount = propagatePayload.affectedCount ?? 0;
      skippedExistingCount = propagatePayload.skippedExistingCount ?? 0;
    }

    setSaving(false);
    setModalPlant(null);
    setModalCrop(null);
    setModalAspectRatio(null);
    setAddingPlantId("");
    setPropagateResult(
      applyTarget === "this-photo-only"
        ? `Saved crop for ${modalPlant.name}.`
        : `Saved crop for ${modalPlant.name} and applied it to ${propagatedCount} photo(s)` +
            (skippedExistingCount > 0 ? `, skipping ${skippedExistingCount} existing crop(s).` : "."),
    );
    router.refresh();
  }

  async function removeCrop(cropId: string) {
    setRemovingCropId(cropId);
    await fetch(`/api/plant-photo-crops/${cropId}`, { method: "DELETE" });
    setRemovingCropId(null);
    router.refresh();
    return true;
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-stone-950">Plant Crops</h2>

      {crops.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">No plants have a saved crop in this photo yet.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {crops.map((crop) => (
            <div key={crop.id} className="grid gap-2 rounded-md border border-stone-200 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div
                data-testid="plant-crop-card-image"
                className="grid min-h-28 place-items-center rounded bg-black"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={buildCropThumbnailUrl(crop, { width: 320, height: 320 })}
                  alt={`${crop.plantName} crop`}
                  className="max-h-80 max-w-full rounded object-contain"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Link href={`/plants/${crop.plantId}`} className="text-sm font-semibold text-emerald-700">
                  {crop.plantName}
                </Link>
              </div>
              {crop.createdMethod === "propagated" ? (
                <p className="text-xs font-medium text-stone-500">Inherited crop</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() =>
                    openEditor(
                      { id: crop.plantId, name: crop.plantName, cropId: crop.id },
                      {
                        cropX: crop.cropX,
                        cropY: crop.cropY,
                        cropWidth: crop.cropWidth,
                        cropHeight: crop.cropHeight,
                      },
                    )
                  }
                >
                  Edit Crop
                </button>
                <ConfirmActionButton
                  title="Remove Plant Crop"
                  message={`Remove the saved crop for ${crop.plantName} in this photo?`}
                  confirmLabel="Remove Crop"
                  onConfirm={() => removeCrop(crop.id)}
                  disabled={removingCropId === crop.id}
                >
                  {removingCropId === crop.id ? "Removing..." : "Remove"}
                </ConfirmActionButton>
              </div>
            </div>
          ))}
        </div>
      )}

      {plantsWithoutCrop.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4">
          <select
            className="input w-auto"
            value={addingPlantId}
            onChange={(event) => setAddingPlantId(event.target.value)}
          >
            <option value="">Add a crop for...</option>
            {plantsWithoutCrop.map((plant) => (
              <option key={plant.id} value={plant.id}>
                {plant.name}
              </option>
            ))}
          </select>
          <button type="button" className="button-secondary" onClick={openAddCrop} disabled={!addingPlantId}>
            Set Plant Crop
          </button>
        </div>
      ) : null}

      {propagateResult ? <p className="mt-3 text-sm font-medium text-emerald-700">{propagateResult}</p> : null}

      {modalPlant ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <div className="grid max-h-[90vh] w-full max-w-2xl gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-950">Set Plant Crop - {modalPlant.name}</h2>
            <PlantCropEditor
              imageUrl={imageUrl}
              value={modalCrop}
              visualAspectRatio={modalAspectRatio}
              onChange={setModalCrop}
              onVisualAspectRatioChange={setModalAspectRatio}
            />
            <div className="grid gap-2 rounded-md border border-stone-200 p-3">
              <p className="text-sm font-semibold text-stone-950">Apply crop to:</p>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="radio"
                  name="applyTarget"
                  checked={applyTarget === "this-photo-only"}
                  onChange={() => setApplyTarget("this-photo-only")}
                />
                This photo only
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="radio"
                  name="applyTarget"
                  checked={applyTarget === "later-without-crop"}
                  onChange={() => setApplyTarget("later-without-crop")}
                />
                This and later photos without a crop -{" "}
                {propagationCounts["later-without-crop"]?.affectedCount ?? "..."} photos
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="radio"
                  name="applyTarget"
                  checked={applyTarget === "all-without-crop"}
                  onChange={() => setApplyTarget("all-without-crop")}
                />
                All project photos without a crop - {propagationCounts["all-without-crop"]?.affectedCount ?? "..."} photos
              </label>
              <label className="mt-1 flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={overwriteExisting}
                  onChange={(event) => {
                    setOverwriteExisting(event.target.checked);
                    setOverwriteConfirmed(false);
                    if (modalPlant) {
                      void loadPropagationCounts(modalPlant.id, event.target.checked);
                    }
                  }}
                />
                Overwrite existing crops for this plant
              </label>
              {overwriteExisting ? (
                <label className="flex items-center gap-2 text-sm font-medium text-red-700">
                  <input
                    type="checkbox"
                    checked={overwriteConfirmed}
                    onChange={(event) => setOverwriteConfirmed(event.target.checked)}
                  />
                  I understand existing crop rectangles will be replaced.
                </label>
              ) : null}
              <p className="text-xs text-stone-500">
                Bulk choices store actual crop rectangles on each target photo. Existing crops are skipped unless
                overwrite is explicitly confirmed.
              </p>
            </div>
            {saveError ? <p className="text-sm font-medium text-red-700">{saveError}</p> : null}
            <div className="sticky bottom-0 -mx-5 -mb-5 flex justify-end gap-2 border-t border-stone-200 bg-white p-5">
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setModalPlant(null);
                  setModalCrop(null);
                }}
              >
                Cancel
              </button>
              <button className="button" onClick={saveCrop} disabled={saving || !modalCrop}>
                {saving ? "Saving..." : "Save Crop"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
