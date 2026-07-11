"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraSelect } from "@/components/CameraSelect";
import {
  CaptureScheduleFields,
  captureSchedulePayload,
  initialScheduleValue,
  type CaptureScheduleValue,
} from "@/components/CaptureScheduleFields";

export function CaptureSourceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [cameraDevice, setCameraDevice] = useState("");
  const [cameraName, setCameraName] = useState<string | null>(null);
  const [cameraStableId, setCameraStableId] = useState<string | null>(null);
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [schedule, setSchedule] = useState<CaptureScheduleValue>(() =>
    initialScheduleValue({
      photoIntervalMinutes: 30,
      captureStartAt: new Date().toISOString().slice(0, 16),
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const response = await fetch("/api/capture-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        cameraDevice,
        cameraName,
        cameraStableId,
        width: Number(width),
        height: Number(height),
        ...captureSchedulePayload(schedule),
      }),
    });
    const payload = await response.json();

    setSaving(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not create capture source.");
      return;
    }

    router.push(`/capture-sources/${payload.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <label className="field">
        Name
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Grow Tent Shelf 1"
          required
        />
      </label>

      <CameraSelect
        defaultDevice={cameraDevice}
        defaultName={cameraName}
        onDeviceChange={setCameraDevice}
        onCameraChange={(camera) => {
          setCameraName(camera?.name ?? null);
          setCameraStableId(camera?.stableId ?? null);
        }}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          Width (raw capture, before rotation)
          <input
            className="input"
            type="number"
            min={1}
            value={width}
            onChange={(event) => setWidth(event.target.value)}
            required
          />
        </label>
        <label className="field">
          Height (raw capture, before rotation)
          <input
            className="input"
            type="number"
            min={1}
            value={height}
            onChange={(event) => setHeight(event.target.value)}
            required
          />
        </label>
      </div>

      <CaptureScheduleFields value={schedule} onChange={(patch) => setSchedule((current) => ({ ...current, ...patch }))} />

      <p className="text-xs text-stone-600">
        Projects using this shelf camera share its capture schedule - there is no per-project cadence
        override for a shared source.
      </p>

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      <button className="button w-fit" disabled={saving || !cameraDevice}>
        {saving ? "Creating..." : "Create Shelf Camera"}
      </button>
    </form>
  );
}
