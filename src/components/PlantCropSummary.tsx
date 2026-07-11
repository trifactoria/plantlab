"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { PlantCropEditor, type CropValue } from "@/components/PlantCropEditor";
import { buildCropThumbnailUrl } from "@/lib/cropThumbnail";

type ProjectPlant = {
  id: string;
  name: string;
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
};

type PropagationTarget = "later-without-crop" | "all-without-crop";

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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removingCropId, setRemovingCropId] = useState<string | null>(null);

  const [propagateOffer, setPropagateOffer] = useState<{ plantId: string; plantName: string } | null>(null);
  const [propagatePreview, setPropagatePreview] = useState<{
    target: PropagationTarget;
    affectedCount: number;
    skippedExistingCount: number;
  } | null>(null);
  const [propagating, setPropagating] = useState(false);
  const [propagateResult, setPropagateResult] = useState<string | null>(null);
  const [propagateError, setPropagateError] = useState<string | null>(null);

  function openEditor(plant: { id: string; name: string; cropId?: string }, crop: CropValue | null) {
    setSaveError(null);
    setModalPlant(plant);
    setModalCrop(crop);
  }

  function openAddCrop() {
    const plant = plants.find((item) => item.id === addingPlantId);
    if (!plant) {
      return;
    }
    openEditor(plant, null);
  }

  async function saveCrop() {
    if (!modalPlant || !modalCrop) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    const response = await fetch("/api/plant-photo-crops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plantId: modalPlant.id, photoId, ...modalCrop }),
    });
    const payload = (await response.json()) as { error?: string };
    setSaving(false);

    if (!response.ok) {
      setSaveError(payload.error ?? "Could not save crop.");
      return;
    }

    const savedPlant = { plantId: modalPlant.id, plantName: modalPlant.name };
    setModalPlant(null);
    setModalCrop(null);
    setAddingPlantId("");
    setPropagateResult(null);
    setPropagateOffer(savedPlant);
    router.refresh();
  }

  async function removeCrop(cropId: string) {
    setRemovingCropId(cropId);
    await fetch(`/api/plant-photo-crops/${cropId}`, { method: "DELETE" });
    setRemovingCropId(null);
    router.refresh();
    return true;
  }

  async function previewPropagate(target: PropagationTarget) {
    if (!propagateOffer) {
      return;
    }

    setPropagateError(null);
    const response = await fetch("/api/plant-photo-crops/propagate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plantId: propagateOffer.plantId,
        sourcePhotoId: photoId,
        target,
        dryRun: true,
      }),
    });
    const payload = (await response.json()) as {
      affectedCount?: number;
      skippedExistingCount?: number;
      error?: string;
    };

    if (!response.ok) {
      setPropagateError(payload.error ?? "Could not preview propagation.");
      return;
    }

    setPropagatePreview({
      target,
      affectedCount: payload.affectedCount ?? 0,
      skippedExistingCount: payload.skippedExistingCount ?? 0,
    });
  }

  async function confirmPropagate() {
    if (!propagateOffer || !propagatePreview) {
      return false;
    }

    setPropagating(true);
    setPropagateError(null);

    const response = await fetch("/api/plant-photo-crops/propagate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plantId: propagateOffer.plantId,
        sourcePhotoId: photoId,
        target: propagatePreview.target,
        dryRun: false,
      }),
    });
    const payload = (await response.json()) as {
      affectedCount?: number;
      skippedExistingCount?: number;
      error?: string;
    };
    setPropagating(false);

    if (!response.ok) {
      setPropagateError(payload.error ?? "Could not propagate crop.");
      return false;
    }

    const skipped = payload.skippedExistingCount ?? 0;
    setPropagateResult(
      `Created ${payload.affectedCount ?? 0} crop(s) for ${propagateOffer.plantName}` +
        (skipped > 0 ? `, skipped ${skipped} photo(s) that already had a crop.` : "."),
    );
    setPropagatePreview(null);
    setPropagateOffer(null);
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
              <img
                src={buildCropThumbnailUrl(crop, { size: 240 })}
                alt={`${crop.plantName} crop`}
                className="aspect-square w-full rounded object-cover"
              />
              <div className="flex items-center justify-between gap-2">
                <Link href={`/plants/${crop.plantId}`} className="text-sm font-semibold text-emerald-700">
                  {crop.plantName}
                </Link>
              </div>
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

      {propagateOffer ? (
        <div className="mt-4 grid gap-2 rounded-md border border-cyan-200 bg-cyan-50 p-3">
          <p className="text-sm text-stone-800">
            Crop saved for <strong>{propagateOffer.plantName}</strong>. Apply this crop to other photos too?
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="button-secondary" onClick={() => setPropagateOffer(null)}>
              This Photo Only
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => previewPropagate("later-without-crop")}
            >
              This and Later Photos Without a Crop
            </button>
            <button type="button" className="button-secondary" onClick={() => previewPropagate("all-without-crop")}>
              All Project Photos Without a Crop
            </button>
          </div>
          <p className="text-xs text-stone-600">
            Existing crops for other photos are never overwritten. This assumes the camera and tray stay
            fixed - you can still edit any individual photo&apos;s crop afterward.
          </p>
          {propagateError ? <p className="text-sm font-medium text-red-700">{propagateError}</p> : null}
        </div>
      ) : null}

      {propagatePreview ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <div className="grid w-full max-w-md gap-4 rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-950">Confirm Crop Propagation</h2>
            <p className="text-sm text-stone-700">
              This will create <strong>{propagatePreview.affectedCount}</strong> new plant crop
              {propagatePreview.affectedCount === 1 ? "" : "s"}
              {propagatePreview.skippedExistingCount > 0
                ? `, skipping ${propagatePreview.skippedExistingCount} photo(s) that already have a crop for this plant`
                : ""}
              .
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setPropagatePreview(null)}>
                Cancel
              </button>
              <button className="button" onClick={confirmPropagate} disabled={propagating}>
                {propagating ? "Applying..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modalPlant ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <div className="grid max-h-[90vh] w-full max-w-2xl gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-950">Set Plant Crop - {modalPlant.name}</h2>
            <PlantCropEditor imageUrl={imageUrl} value={modalCrop} onChange={setModalCrop} />
            {saveError ? <p className="text-sm font-medium text-red-700">{saveError}</p> : null}
            <div className="flex justify-end gap-2">
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
