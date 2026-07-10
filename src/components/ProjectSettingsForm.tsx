"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraSelect } from "@/components/CameraSelect";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { validateCaptureConfig } from "@/lib/captureValidation";
import { toDateTimeLocal } from "@/lib/format";

type ProjectSettings = {
  id: string;
  name: string;
  description: string | null;
  gridWidth: number;
  gridHeight: number;
  photoIntervalMinutes: number;
  captureStartAt: string;
  captureEnabled: boolean;
  plantedAt: string | null;
  localPhotoDirectory: string;
  cameraDevice: string | null;
  cameraName: string | null;
};

export function ProjectSettingsForm({ project }: { project: ProjectSettings }) {
  const router = useRouter();
  const [photoDirectory, setPhotoDirectory] = useState(project.localPhotoDirectory);
  const [useCustomFolder, setUseCustomFolder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [plantingUnknown, setPlantingUnknown] = useState(project.plantedAt === null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraDevice, setCameraDevice] = useState(project.cameraDevice ?? "");
  const [photoIntervalMinutes, setPhotoIntervalMinutes] = useState(
    String(project.photoIntervalMinutes),
  );
  const [captureStartAt, setCaptureStartAt] = useState(toDateTimeLocal(project.captureStartAt));
  const [captureEnabled, setCaptureEnabled] = useState(project.captureEnabled);

  const captureErrors = validateCaptureConfig({
    captureStartAt: captureStartAt || null,
    photoIntervalMinutes: Number.parseInt(photoIntervalMinutes, 10),
    cameraDevice: cameraDevice || null,
    localPhotoDirectory: useCustomFolder ? photoDirectory : project.localPhotoDirectory,
  });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (captureEnabled && captureErrors.length > 0) {
      setError(captureErrors.join(" "));
      return;
    }

    setSaving(true);

    const formData = new FormData(event.currentTarget);
    const customDirectory = useCustomFolder ? photoDirectory : undefined;
    const response = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        description: formData.get("description"),
        gridWidth: formData.get("gridWidth"),
        gridHeight: formData.get("gridHeight"),
        photoIntervalMinutes,
        captureStartAt: new Date(captureStartAt).toISOString(),
        captureEnabled,
        plantedAt: plantingUnknown
          ? null
          : new Date(String(formData.get("plantedAt"))).toISOString(),
        localPhotoDirectory: customDirectory,
        cameraDevice,
        cameraName: formData.get("cameraName"),
      }),
    });
    const payload = (await response.json()) as { error?: string };

    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not update project");
      return;
    }

    setMessage("Project settings saved.");
    router.refresh();
  }

  async function deleteProject() {
    setDeleting(true);
    setMessage(null);
    setError(null);

    const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    const payload = (await response.json()) as { error?: string };

    setDeleting(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not delete project");
      return false;
    }

    router.push("/");
    router.refresh();
    return true;
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={save} className="grid gap-4 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <label className="field">
          Name
          <input className="input" name="name" defaultValue={project.name} required />
        </label>
        <label className="field">
          Description
          <textarea className="input min-h-24" name="description" defaultValue={project.description ?? ""} />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="field">
            Grid width
            <input className="input" name="gridWidth" type="number" min="1" defaultValue={project.gridWidth} required />
          </label>
          <label className="field">
            Grid height
            <input className="input" name="gridHeight" type="number" min="1" defaultValue={project.gridHeight} required />
          </label>
          <label className="field">
            Photo interval
            <input
              className="input"
              name="photoIntervalMinutes"
              type="number"
              min="1"
              value={photoIntervalMinutes}
              onChange={(event) => setPhotoIntervalMinutes(event.target.value)}
              required
            />
          </label>
        </div>

        <label className="field">
          Planting date and time
          <input
            className="input"
            name="plantedAt"
            type="datetime-local"
            defaultValue={
              project.plantedAt ? toDateTimeLocal(project.plantedAt) : toDateTimeLocal(new Date().toISOString())
            }
            disabled={plantingUnknown}
            required={!plantingUnknown}
          />
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
          <input
            type="checkbox"
            checked={plantingUnknown}
            onChange={(event) => setPlantingUnknown(event.target.checked)}
          />
          Planting date/time unknown
        </label>

        <label className="field">
          Schedule starting date and time
          <input
            className="input"
            name="captureStartAt"
            type="datetime-local"
            value={captureStartAt}
            onChange={(event) => setCaptureStartAt(event.target.value)}
            required
          />
        </label>

        <CameraSelect
          defaultDevice={project.cameraDevice}
          defaultName={project.cameraName}
          onDeviceChange={setCameraDevice}
        />

        <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
          <div>
            <p className="text-sm font-medium text-stone-950">Current photo folder</p>
            <p className="mt-1 break-all font-mono text-xs text-stone-600">
              {project.localPhotoDirectory}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
            <input
              type="checkbox"
              checked={useCustomFolder}
              onChange={(event) => setUseCustomFolder(event.target.checked)}
            />
            Use a custom photo folder
          </label>
          {useCustomFolder ? (
            <>
              <label className="field">
                Custom photo folder
                <input
                  className="input"
                  name="localPhotoDirectory"
                  value={photoDirectory}
                  onChange={(event) => setPhotoDirectory(event.target.value)}
                  required
                />
              </label>
              {photoDirectory !== project.localPhotoDirectory ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Existing photos remain at their old file paths. PlantLab will use the new directory for future scans and captures.
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
            <input
              type="checkbox"
              checked={captureEnabled}
              onChange={(event) => setCaptureEnabled(event.target.checked)}
            />
            Enable scheduled capture
          </label>
          {captureEnabled && captureErrors.length > 0 ? (
            <ul className="list-disc pl-5 text-sm text-amber-800">
              {captureErrors.map((captureError) => (
                <li key={captureError}>{captureError}</li>
              ))}
            </ul>
          ) : null}
        </div>

        {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}
        {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

        <button className="button w-fit" disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </form>

      <div className="rounded-lg border border-red-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-red-800">Delete Project</h2>
        <p className="mt-2 text-sm text-stone-600">
          Project data will be removed from PlantLab. The image directory and files remain on disk.
        </p>
        <div className="mt-4">
          <ConfirmActionButton
            title="Delete Project"
            message="Project data will be removed from PlantLab, but the image directory and files will remain on disk."
            confirmLabel="Delete Project"
            onConfirm={deleteProject}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete Project"}
          </ConfirmActionButton>
        </div>
      </div>
    </div>
  );
}
