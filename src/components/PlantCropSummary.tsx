"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { CropVersionPanel } from "@/components/CropVersionPanel";
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

/**
 * Per-photo crop summary. Editing/creating a crop opens CropVersionPanel
 * (Set initial crop / Adjust crop from this frame forward / Save size as
 * project default), which is the single crop-management surface shared
 * with visual-history playback - see src/components/CropVersionPanel.tsx.
 */
export function PlantCropSummary({
  projectId,
  photoId,
  photoTimestamp,
  imageUrl,
  plants,
  crops,
}: {
  projectId: string;
  photoId: string;
  photoTimestamp: string;
  imageUrl: string;
  plants: ProjectPlant[];
  crops: ExistingCrop[];
}) {
  const router = useRouter();
  const plantsWithoutCrop = plants.filter((plant) => !crops.some((crop) => crop.plantId === plant.id));

  const [addingPlantId, setAddingPlantId] = useState("");
  const [activePlant, setActivePlant] = useState<{ id: string; name: string } | null>(null);
  const [removingCropId, setRemovingCropId] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  function openAddCrop() {
    const plant = plants.find((item) => item.id === addingPlantId);
    if (!plant) {
      return;
    }
    setActivePlant({ id: plant.id, name: plant.name });
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-950">Plant Crops</h2>
        <Link href={`/projects/${projectId}/crop-setup?photoId=${photoId}`} className="button-secondary">
          Configure Project Crops
        </Link>
      </div>

      {crops.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">No plants have a saved crop in this photo yet.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {crops.map((crop) => (
            <div key={crop.id} className="grid gap-2 rounded-md border border-stone-200 p-3">
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
              {crop.createdMethod !== "manual" ? (
                <p className="text-xs font-medium text-stone-500">
                  {crop.createdMethod === "propagated" ? "Inherited crop" : crop.createdMethod.replace(/_/g, " ")}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setActivePlant({ id: crop.plantId, name: crop.plantName })}
                >
                  Adjust Crop
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
            aria-label="Add plant crop"
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

      {saveMessage ? <p className="mt-3 text-sm font-medium text-emerald-700">{saveMessage}</p> : null}

      {activePlant ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <CropVersionPanel
            plantId={activePlant.id}
            plantName={activePlant.name}
            projectId={projectId}
            photoId={photoId}
            photoTimestamp={photoTimestamp}
            imageUrl={imageUrl}
            onCancel={() => setActivePlant(null)}
            onSaved={(message) => {
              setActivePlant(null);
              setAddingPlantId("");
              setSaveMessage(message);
              router.refresh();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
