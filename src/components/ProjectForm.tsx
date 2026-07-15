"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CaptureSourceSelect } from "@/components/CaptureSourceSelect";
import {
  CaptureScheduleFields,
  browserTimeZone,
  captureSchedulePayload,
  initialScheduleValue,
  type CaptureScheduleValue,
} from "@/components/CaptureScheduleFields";
import { ProjectSensorChecklist } from "@/components/ProjectSensorChecklist";
import { validateCaptureConfig } from "@/lib/captureValidation";
import { toDateTimeLocal } from "@/lib/format";
import { safeTimeInputToMinutes } from "@/lib/timezone";

type ProjectResponse = {
  id: string;
};

export function ProjectForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [useDefaultFolder, setUseDefaultFolder] = useState(true);
  const [plantingUnknown, setPlantingUnknown] = useState(false);
  const [captureSourceId, setCaptureSourceId] = useState("");
  const [selectedSensorIds, setSelectedSensorIds] = useState<Set<string>>(new Set());
  const [schedule, setSchedule] = useState<CaptureScheduleValue>(() =>
    initialScheduleValue({
      timeZone: browserTimeZone(),
      photoIntervalMinutes: 30,
      captureStartAt: toDateTimeLocal(new Date().toISOString()),
    }),
  );
  const [localPhotoDirectory, setLocalPhotoDirectory] = useState("");
  const [captureEnabled, setCaptureEnabled] = useState(false);

  // The coordinator validates capture-source eligibility itself
  // (validateProjectCaptureSourceSelection) - the local cameraDevice/
  // directory/schedule checks below only apply when no capture source is
  // selected, mirroring POST /api/projects's own branch.
  const captureErrors = captureSourceId
    ? []
    : validateCaptureConfig({
        captureStartAt: schedule.captureStartAt || null,
        photoIntervalMinutes: Number.parseInt(schedule.photoIntervalMinutes, 10),
        cameraDevice: null,
        localPhotoDirectory: useDefaultFolder ? "auto" : localPhotoDirectory,
        timeZone: schedule.timeZone,
        captureWindowEnabled: schedule.captureWindowEnabled,
        captureWindowStartMinutes: schedule.captureWindowEnabled ? safeTimeInputToMinutes(schedule.captureWindowStart) : null,
        captureWindowEndMinutes: schedule.captureWindowEnabled ? safeTimeInputToMinutes(schedule.captureWindowEnd) : null,
      });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (captureEnabled && captureErrors.length > 0) {
      setError(captureErrors.join(" "));
      return;
    }

    setSaving(true);

    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        description: formData.get("description"),
        gridWidth: formData.get("gridWidth"),
        gridHeight: formData.get("gridHeight"),
        ...captureSchedulePayload(schedule),
        captureEnabled,
        plantedAt: plantingUnknown
          ? null
          : new Date(String(formData.get("plantedAt"))).toISOString(),
        useDefaultPhotoDirectory: useDefaultFolder,
        localPhotoDirectory,
        captureSourceId: captureSourceId || undefined,
      }),
    });

    const payload = (await response.json()) as ProjectResponse & { error?: string };

    if (!response.ok) {
      setSaving(false);
      setError(payload.error ?? "Could not create project");
      return;
    }

    // Best-effort: the project itself is already created, so a failed
    // sensor link is not fatal - it can be added later from Project
    // Settings. Fire all links in parallel rather than serially.
    await Promise.allSettled(
      [...selectedSensorIds].map((sensorId) =>
        fetch(`/api/projects/${payload.id}/sensors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sensorId }),
        }),
      ),
    );

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

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          Grid width
          <input className="input" name="gridWidth" type="number" min="1" defaultValue="3" required />
        </label>
        <label className="field">
          Grid height
          <input className="input" name="gridHeight" type="number" min="1" defaultValue="6" required />
        </label>
      </div>

      <label className="field">
        Planting date and time
        <input
          className="input"
          name="plantedAt"
          type="datetime-local"
          defaultValue={toDateTimeLocal(new Date().toISOString())}
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

      <CaptureScheduleFields value={schedule} onChange={(patch) => setSchedule((current) => ({ ...current, ...patch }))} />

      <CaptureSourceSelect onChange={setCaptureSourceId} />

      <ProjectSensorChecklist selected={selectedSensorIds} onChange={setSelectedSensorIds} />

      <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
          <input
            name="useDefaultPhotoDirectory"
            type="checkbox"
            checked={useDefaultFolder}
            onChange={(event) => setUseDefaultFolder(event.target.checked)}
          />
          Create and use a PlantLab photo folder for this project
        </label>
        {!useDefaultFolder ? (
          <label className="field">
            Custom photo folder
            <input
              className="input"
              name="localPhotoDirectory"
              placeholder="/home/andy/plant-photos/radish"
              value={localPhotoDirectory}
              onChange={(event) => setLocalPhotoDirectory(event.target.value)}
              required
            />
          </label>
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
            {captureErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      <button className="button w-fit" disabled={saving}>
        {saving ? "Saving..." : "Create Project"}
      </button>
    </form>
  );
}
