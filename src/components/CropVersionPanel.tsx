"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PlantCropEditor, type CropValue } from "@/components/PlantCropEditor";
import { type CropShape } from "@/lib/cropGeometry";
import { formatDateTime } from "@/lib/format";

type VersionSummary = {
  id: string;
  effectiveFrom: string;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  aspectRatioMode: string;
};

/**
 * The primary crop-management surface for one plant at one selected frame
 * (photo). Used from the photo page and from visual-history playback -
 * both just supply which photo is "the selected frame." Replaces the old
 * "Apply crop to: this photo / later / all + overwrite" radio group with
 * the four documented actions: Set initial crop, Adjust crop from this
 * frame forward, Save size as project default, and (collapsed) repair /
 * inspect versions / automatic-assignment toggle.
 */
export function CropVersionPanel({
  plantId,
  plantName,
  projectId,
  photoId,
  photoTimestamp,
  imageUrl,
  onCancel,
  onSaved,
}: {
  plantId: string;
  plantName: string;
  projectId: string;
  photoId: string;
  photoTimestamp: string;
  imageUrl: string;
  onCancel: () => void;
  onSaved?: (message: string) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [autoAssignEnabled, setAutoAssignEnabled] = useState(true);
  const [crop, setCrop] = useState<CropValue | null>(null);
  // null (not "free") when nothing has set a shape yet - PlantCropEditor
  // treats a non-null value as "explicitly selected," which disables its
  // own infer-shape-from-drag-direction behavior. Only set this to a
  // concrete CropShape once we actually know one (existing crop, active
  // version, preset, or the user clicking a shape button).
  const [shape, setShape] = useState<CropShape | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const [plantPayload, versionsPayload, presetPayload, existingCropPayload] = await Promise.all([
        fetch(`/api/plants/${plantId}`).then((response) => response.json()),
        fetch(`/api/plants/${plantId}/crop-versions`).then((response) => response.json()),
        fetch(`/api/projects/${projectId}/crop-preset`).then((response) => response.json()),
        fetch(`/api/plant-photo-crops?plantId=${plantId}&photoId=${photoId}`).then((response) => response.json()),
      ]);

      if (cancelled) {
        return;
      }

      const loadedVersions: VersionSummary[] = versionsPayload.versions ?? [];
      setVersions(loadedVersions);
      setAutoAssignEnabled(plantPayload.automaticCropAssignmentEnabled ?? true);

      const existingCrop = existingCropPayload.crop as CropValue | null;
      const photoTimestampMs = new Date(photoTimestamp).getTime();
      const activeVersion = [...loadedVersions]
        .reverse()
        .find((version) => new Date(version.effectiveFrom).getTime() <= photoTimestampMs);

      if (existingCrop) {
        setCrop(existingCrop);
        if (activeVersion) {
          setShape(activeVersion.aspectRatioMode as CropShape);
        }
      } else if (activeVersion) {
        setCrop({
          cropX: activeVersion.cropX,
          cropY: activeVersion.cropY,
          cropWidth: activeVersion.cropWidth,
          cropHeight: activeVersion.cropHeight,
        });
        setShape(activeVersion.aspectRatioMode as CropShape);
      } else if (presetPayload.preset) {
        const preset = presetPayload.preset as { width: number; height: number; aspectRatioMode: CropShape };
        const width = Math.min(1, preset.width);
        const height = Math.min(1, preset.height);
        setCrop({
          cropX: (1 - width) / 2,
          cropY: (1 - height) / 2,
          cropWidth: width,
          cropHeight: height,
        });
        setShape(preset.aspectRatioMode);
      }

      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [plantId, projectId, photoId, photoTimestamp]);

  const hasCropHistory = versions.length > 0;

  // The user isn't required to explicitly click a shape button - dragging
  // out a crop already infers landscape/portrait from the drag direction
  // (see PlantCropEditor), it just doesn't report that back up here. Fall
  // back to inferring one from the drawn rectangle itself, same rule the
  // legacy /api/plant-photo-crops route used server-side.
  function effectiveShape(): CropShape {
    if (shape) {
      return shape;
    }
    if (crop && crop.cropWidth < crop.cropHeight) {
      return "9:16";
    }
    return "16:9";
  }

  async function saveCropVersion() {
    if (!crop) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);

    const response = await fetch(`/api/plants/${plantId}/crop-versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePhotoId: photoId, aspectRatioMode: effectiveShape(), ...crop }),
    });
    const payload = (await response.json()) as { error?: string };
    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not save crop.");
      return;
    }

    // onSaved typically closes (unmounts) this panel immediately, so the
    // success message is reported to the caller to display in its own
    // layout rather than set locally here where it would never be seen.
    // Refreshing is also the caller's responsibility for the same reason.
    onSaved?.(hasCropHistory ? "Crop updated from this frame forward." : "Initial crop set.");
  }

  async function saveAsProjectDefault() {
    if (!crop) {
      return;
    }
    await fetch(`/api/projects/${projectId}/crop-preset`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ width: crop.cropWidth, height: crop.cropHeight, aspectRatioMode: effectiveShape() }),
    });
    setMessage("Saved this size as the project default.");
  }

  async function toggleAutoAssign() {
    const next = !autoAssignEnabled;
    setAutoAssignEnabled(next);
    await fetch(`/api/plants/${plantId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automaticCropAssignmentEnabled: next }),
    });
    router.refresh();
  }

  async function runRepair() {
    setRepairing(true);
    setRepairMessage(null);
    const response = await fetch(`/api/plants/${plantId}/visual-history/repair`, { method: "POST" });
    const payload = (await response.json()) as {
      added: number;
      skippedExisting: number;
      preservedManual: number;
      noApplicableVersion: number;
      failed: number;
    };
    setRepairing(false);

    if (response.ok) {
      setRepairMessage(
        `Added ${payload.added}, skipped ${payload.skippedExisting} existing (${payload.preservedManual} manual), ${payload.noApplicableVersion} had no applicable version, ${payload.failed} failed.`,
      );
      router.refresh();
    }
  }

  if (loading) {
    return (
      <div className="grid max-h-[90vh] w-full max-w-2xl gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <p className="text-sm text-stone-600">Loading crop editor...</p>
      </div>
    );
  }

  return (
    <div className="grid max-h-[90vh] w-full max-w-2xl gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
      <div>
        <h2 className="text-lg font-semibold text-stone-950">
          {hasCropHistory ? `Adjust Crop - ${plantName}` : `Set Initial Crop - ${plantName}`}
        </h2>
        <p className="text-sm text-stone-500">Selected frame: {formatDateTime(photoTimestamp)}</p>
      </div>

      <PlantCropEditor
        imageUrl={imageUrl}
        value={crop}
        visualAspectRatio={shape}
        onChange={setCrop}
        onVisualAspectRatioChange={setShape}
      />

      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" checked={autoAssignEnabled} onChange={toggleAutoAssign} />
        Automatic crop assignment for new photos is {autoAssignEnabled ? "on" : "off"}
      </label>

      {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap justify-end gap-2 border-t border-stone-200 bg-white p-5">
        <button type="button" className="button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-secondary" onClick={saveAsProjectDefault} disabled={!crop}>
          Save size as project default
        </button>
        <button type="button" className="button" onClick={saveCropVersion} disabled={!crop || saving}>
          {saving ? "Saving..." : hasCropHistory ? "Adjust crop from this frame forward" : "Set initial crop"}
        </button>
      </div>

      <details className="rounded-md border border-stone-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-stone-800">Advanced</summary>
        <div className="mt-3 grid gap-3">
          <div>
            <button
              type="button"
              className="button-secondary"
              onClick={runRepair}
              disabled={repairing || !hasCropHistory}
            >
              {repairing ? "Repairing..." : "Fill missing frames"}
            </button>
            {repairMessage ? <p className="mt-2 text-xs text-stone-600">{repairMessage}</p> : null}
          </div>
          <div>
            <p className="text-sm font-semibold text-stone-800">Crop versions ({versions.length})</p>
            {versions.length === 0 ? (
              <p className="text-xs text-stone-500">No crop versions yet.</p>
            ) : (
              <ul className="mt-1 grid gap-1 text-xs text-stone-600">
                {versions.map((version) => (
                  <li key={version.id}>
                    {formatDateTime(version.effectiveFrom)} - {version.aspectRatioMode} (
                    {(version.cropWidth * 100).toFixed(0)}% x {(version.cropHeight * 100).toFixed(0)}%)
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
