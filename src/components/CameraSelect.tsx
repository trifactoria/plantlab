"use client";

import { useEffect, useState } from "react";

type Camera = {
  name: string;
  device: string;
  supportsCapture: boolean;
};

export function CameraSelect({
  defaultDevice,
  defaultName,
  onDeviceChange,
}: {
  defaultDevice?: string | null;
  defaultName?: string | null;
  onDeviceChange?: (device: string) => void;
}) {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedDevice, setSelectedDevice] = useState(defaultDevice ?? "");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedCamera = cameras.find((camera) => camera.device === selectedDevice);
  const selectedName = selectedCamera?.name ?? (selectedDevice ? defaultName ?? "" : "");

  useEffect(() => {
    onDeviceChange?.(selectedDevice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice]);

  async function loadCameras() {
    setLoading(true);
    setMessage(null);

    const response = await fetch("/api/cameras");
    const payload = (await response.json()) as {
      cameras?: Camera[];
      error?: string;
    };

    setLoading(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Could not load local cameras.");
      return;
    }

    setCameras(payload.cameras ?? []);

    if ((payload.cameras ?? []).length === 0) {
      setMessage("No local V4L2 capture cameras were detected.");
    }
  }

  useEffect(() => {
    void loadCameras();
  }, []);

  return (
    <div className="grid gap-2">
      <label className="field">
        Camera
        <select
          className="input"
          name="cameraDevice"
          value={selectedDevice}
          onChange={(event) => setSelectedDevice(event.target.value)}
        >
          <option value="">No camera selected</option>
          {cameras.map((camera) => (
            <option key={camera.device} value={camera.device}>
              {camera.name} - {camera.device}
              {camera.supportsCapture ? "" : " (not a capture node)"}
            </option>
          ))}
          {selectedDevice && !selectedCamera ? (
            <option value={selectedDevice}>
              {defaultName ?? "Saved camera"} - {selectedDevice}
            </option>
          ) : null}
        </select>
      </label>
      <input type="hidden" name="cameraName" value={selectedName} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="button-secondary"
          onClick={loadCameras}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh camera list"}
        </button>
        {message ? <span className="text-sm text-stone-600">{message}</span> : null}
      </div>
    </div>
  );
}
