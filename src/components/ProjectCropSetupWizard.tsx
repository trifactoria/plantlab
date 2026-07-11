"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PlantCropEditor, type CropValue } from "@/components/PlantCropEditor";
import { type CropShape } from "@/lib/cropGeometry";
import { formatDateTime } from "@/lib/format";

type PlantCropState = "configured" | "legacy" | "unconfigured";

type SetupPlant = {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  automaticCropAssignmentEnabled: boolean;
  versionCount: number;
  state: PlantCropState;
  crop: CropValue | null;
  cropSource: "legacy_row" | "existing_crop_row" | "active_version" | "none";
  // Server-validated to one of CropAspectRatioMode (see isCropAspectRatioMode
  // in src/lib/cropVersions.ts) but typed loosely here to avoid importing a
  // server module's runtime into this client component just for a type.
  aspectRatioMode: string | null;
};

type SetupData = {
  photo: { id: string; timestamp: string };
  preset: { width: number; height: number; aspectRatioMode: string } | null;
  plants: SetupPlant[];
};

type PhotoOption = { id: string; filename: string; timestamp: string };

function cropsEqual(a: CropValue | null, b: CropValue | null) {
  if (!a || !b) {
    return a === b;
  }
  const epsilon = 1e-6;
  return (
    Math.abs(a.cropX - b.cropX) < epsilon &&
    Math.abs(a.cropY - b.cropY) < epsilon &&
    Math.abs(a.cropWidth - b.cropWidth) < epsilon &&
    Math.abs(a.cropHeight - b.cropHeight) < epsilon
  );
}

// Server-validated by isCropAspectRatioMode before being persisted.
function asCropShape(value: string | null | undefined): CropShape | null {
  return (value as CropShape | null | undefined) ?? null;
}

function suggestFromPreset(preset: SetupData["preset"]): { crop: CropValue; shape: CropShape | null } | null {
  if (!preset) {
    return null;
  }
  const width = Math.min(1, preset.width);
  const height = Math.min(1, preset.height);
  return {
    crop: { cropX: (1 - width) / 2, cropY: (1 - height) / 2, cropWidth: width, cropHeight: height },
    shape: asCropShape(preset.aspectRatioMode),
  };
}

function inferShape(crop: CropValue): CropShape {
  return crop.cropWidth < crop.cropHeight ? "9:16" : "16:9";
}

function stateBadge(plant: SetupPlant) {
  if (plant.state === "configured") {
    return { label: "Configured", className: "bg-emerald-100 text-emerald-800" };
  }
  if (plant.state === "legacy") {
    return { label: "Legacy crop only", className: "bg-amber-100 text-amber-800" };
  }
  return { label: "Not configured", className: "bg-stone-200 text-stone-700" };
}

/**
 * Guided, project-wide crop setup: move a ready-made crop box from plant to
 * plant on one representative photo instead of visiting each plant page.
 * Saving always goes through POST /api/plants/[plantId]/crop-versions - the
 * exact same shared service the per-plant "Set initial crop"/"Adjust crop
 * from this frame forward" actions use (see src/lib/cropVersions.ts).
 */
export function ProjectCropSetupWizard({
  projectId,
  photos,
  initialData,
  initialFilter,
}: {
  projectId: string;
  photos: PhotoOption[];
  initialData: SetupData;
  initialFilter: "all" | "unconfigured";
}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [loadingPhoto, setLoadingPhoto] = useState(false);

  const firstUnconfiguredIndex = initialData.plants.findIndex((plant) => plant.state !== "configured");
  const [currentIndex, setCurrentIndex] = useState(
    initialFilter === "unconfigured" && firstUnconfiguredIndex >= 0 ? firstUnconfiguredIndex : 0,
  );
  const [finished, setFinished] = useState(false);

  const currentPlant = data.plants[currentIndex] ?? null;
  const suggestion = suggestFromPreset(data.preset);

  const [draftCrop, setDraftCrop] = useState<CropValue | null>(currentPlant?.crop ?? suggestion?.crop ?? null);
  const [draftShape, setDraftShape] = useState<CropShape | null>(
    asCropShape(currentPlant?.aspectRatioMode) ?? suggestion?.shape ?? null,
  );
  const loadedCropRef = useRef<CropValue | null>(currentPlant?.crop ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load a fresh draft whenever the current plant or representative photo
  // changes - never carries the previous plant's position forward, per the
  // "do not copy the previous plant's fixed position" requirement.
  useEffect(() => {
    const plant = data.plants[currentIndex];
    if (!plant) {
      return;
    }
    const fallback = suggestFromPreset(data.preset);
    setDraftCrop(plant.crop ?? fallback?.crop ?? null);
    setDraftShape(asCropShape(plant.aspectRatioMode) ?? fallback?.shape ?? null);
    loadedCropRef.current = plant.crop;
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, data.photo.id]);

  const isDirty = !cropsEqual(draftCrop, loadedCropRef.current);
  const willCreateVersion = currentPlant ? currentPlant.state !== "configured" || isDirty : false;

  function saveLabel(): string {
    if (!currentPlant) {
      return "Save";
    }
    if (currentPlant.state === "configured") {
      return isDirty ? "Adjust Crop & Next" : "Next";
    }
    if (currentPlant.state === "legacy" && !isDirty) {
      return "Use This Existing Crop From This Frame Forward";
    }
    return "Set Initial Crop & Next";
  }

  async function performSave(): Promise<boolean> {
    if (!currentPlant) {
      return false;
    }
    if (!willCreateVersion) {
      return true;
    }
    if (!draftCrop) {
      setError("Move or resize the crop rectangle before saving.");
      return false;
    }

    setSaving(true);
    setError(null);
    const response = await fetch(`/api/plants/${currentPlant.id}/crop-versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePhotoId: data.photo.id,
        aspectRatioMode: draftShape ?? inferShape(draftCrop),
        ...draftCrop,
      }),
    });
    const payload = (await response.json()) as { error?: string };
    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not save this plant's crop.");
      return false;
    }

    const savedCrop = draftCrop;
    const savedShape = draftShape ?? inferShape(draftCrop);
    setData((current) => ({
      ...current,
      plants: current.plants.map((plant, index) =>
        index === currentIndex
          ? {
              ...plant,
              state: "configured",
              versionCount: plant.versionCount + 1,
              crop: savedCrop,
              cropSource: "existing_crop_row",
              aspectRatioMode: savedShape,
            }
          : plant,
      ),
    }));
    return true;
  }

  function goTo(index: number) {
    setCurrentIndex(Math.max(0, Math.min(data.plants.length - 1, index)));
  }

  function advanceOrFinish() {
    if (currentIndex + 1 < data.plants.length) {
      goTo(currentIndex + 1);
    } else {
      setFinished(true);
      router.refresh();
    }
  }

  async function saveAndNext() {
    const ok = await performSave();
    if (ok) {
      advanceOrFinish();
    }
  }

  async function saveCurrent() {
    await performSave();
  }

  function skipPlant() {
    advanceOrFinish();
  }

  function cancelAdjustment() {
    const fallback = suggestFromPreset(data.preset);
    setDraftCrop(loadedCropRef.current ?? fallback?.crop ?? null);
    setDraftShape(asCropShape(currentPlant?.aspectRatioMode) ?? fallback?.shape ?? null);
    setError(null);
  }

  async function switchPhoto(photoId: string) {
    setLoadingPhoto(true);
    const response = await fetch(`/api/projects/${projectId}/crop-setup?photoId=${photoId}`);
    setLoadingPhoto(false);
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SetupData;
    setData(payload);
    setCurrentIndex(0);
    setFinished(false);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (finished) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "[") {
        event.preventDefault();
        goTo(currentIndex - 1);
      } else if (event.key === "ArrowRight" || event.key === "]") {
        event.preventDefault();
        advanceOrFinish();
      } else if (event.key === "Enter") {
        event.preventDefault();
        void saveAndNext();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelAdjustment();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, data, draftCrop, draftShape, finished]);

  const configuredCount = data.plants.filter((plant) => plant.state === "configured").length;
  const remainingCount = data.plants.length - configuredCount;

  if (finished) {
    return (
      <div className="grid gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-6" data-testid="crop-setup-complete">
        <h2 className="text-xl font-semibold text-stone-950">Project crop setup complete</h2>
        <p className="text-sm text-stone-700">
          {configuredCount} of {data.plants.length} plants configured
          {remainingCount > 0 ? ` - ${remainingCount} still need an initial crop.` : "."}
        </p>
        <p className="rounded-md border border-emerald-300 bg-white p-3 text-sm text-stone-700">
          Once a plant has an active crop version, every new project photo automatically receives that crop
          until you adjust it from a later frame forward.
        </p>
        <div className="flex flex-wrap gap-2">
          {remainingCount > 0 ? (
            <button type="button" className="button-secondary" onClick={() => setFinished(false)}>
              Continue Configuring Remaining Plants
            </button>
          ) : null}
          <Link href={`/projects/${projectId}`} className="button">
            Back to Project
          </Link>
        </div>
      </div>
    );
  }

  if (!currentPlant) {
    return <p className="text-sm text-stone-600">This project has no plants yet.</p>;
  }

  const badge = stateBadge(currentPlant);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <label className="field min-w-64">
          Representative photo
          <select
            className="input"
            value={data.photo.id}
            onChange={(event) => switchPhoto(event.target.value)}
            disabled={loadingPhoto}
          >
            {photos.map((photo) => (
              <option key={photo.id} value={photo.id}>
                {photo.filename} - {formatDateTime(photo.timestamp)}
              </option>
            ))}
          </select>
        </label>
        <div data-testid="crop-setup-progress" className="text-sm text-stone-700">
          <p className="font-semibold text-stone-950">
            Plant {currentIndex + 1} of {data.plants.length} - {currentPlant.name}
          </p>
          <p>
            {configuredCount} configured · {remainingCount} remaining
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-stone-950">
                {currentPlant.name}{" "}
                <span className="text-sm font-normal text-stone-500">
                  (grid x:{currentPlant.gridX}, y:{currentPlant.gridY})
                </span>
              </h2>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${badge.className}`}>
                {badge.label}
              </span>
              {!currentPlant.automaticCropAssignmentEnabled ? (
                <span className="ml-2 inline-flex rounded-full bg-stone-200 px-2 py-0.5 text-xs font-semibold text-stone-700">
                  Automatic assignment off
                </span>
              ) : null}
            </div>
          </div>

          <PlantCropEditor
            imageUrl={`/api/photos/${data.photo.id}/file`}
            value={draftCrop}
            visualAspectRatio={draftShape}
            onChange={setDraftCrop}
            onVisualAspectRatioChange={setDraftShape}
          />

          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

          <div className="flex flex-wrap gap-2">
            <button type="button" className="button-secondary" onClick={() => goTo(currentIndex - 1)} disabled={currentIndex === 0}>
              Previous Plant
            </button>
            <button type="button" className="button-secondary" onClick={skipPlant}>
              Skip Plant
            </button>
            <button type="button" className="button-secondary" onClick={saveCurrent} disabled={saving || !draftCrop}>
              {saving ? "Saving..." : "Save Current"}
            </button>
            <button type="button" className="button" onClick={saveAndNext} disabled={saving || !draftCrop}>
              {saving ? "Saving..." : saveLabel()}
            </button>
            <button type="button" className="button-secondary" onClick={() => setFinished(true)}>
              Finish Setup
            </button>
          </div>
          <p className="text-xs text-stone-400">
            Keyboard: [ / Left = previous plant, ] / Right = next plant, Enter = save and next, Escape = reset
            this plant&apos;s adjustment.
          </p>
        </div>

        <div className="grid content-start gap-2 rounded-lg border border-stone-200 bg-white p-4 shadow-sm" data-testid="crop-setup-plant-list">
          <h3 className="text-sm font-semibold text-stone-950">Plants</h3>
          <div className="grid max-h-[560px] gap-1 overflow-y-auto">
            {data.plants.map((plant, index) => {
              const plantBadge = stateBadge(plant);
              return (
                <button
                  key={plant.id}
                  type="button"
                  onClick={() => goTo(index)}
                  className={`flex items-center justify-between gap-2 rounded-md border p-2 text-left text-sm ${
                    index === currentIndex ? "border-emerald-400 bg-emerald-50" : "border-stone-200 bg-white"
                  }`}
                >
                  <span>
                    {plant.name}{" "}
                    <span className="text-xs text-stone-400">
                      (x:{plant.gridX}, y:{plant.gridY})
                    </span>
                  </span>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${plantBadge.className}`}>
                    {plantBadge.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
