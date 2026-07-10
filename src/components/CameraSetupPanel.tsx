"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraSelect } from "@/components/CameraSelect";

type CameraControl = {
  id: string;
  name: string;
  type: "int" | "bool" | "menu" | "unknown";
  value: number | boolean | string;
  minimum?: number;
  maximum?: number;
  step?: number;
  readOnly: boolean;
  options?: Array<{ value: number; label: string }>;
};

export function CameraSetupPanel({
  projectId,
  cameraDevice,
  cameraName,
}: {
  projectId: string;
  cameraDevice: string | null;
  cameraName: string | null;
}) {
  const router = useRouter();
  const [savingCamera, setSavingCamera] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [controls, setControls] = useState<CameraControl[]>([]);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [loadingControls, setLoadingControls] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureInFlight = useRef(false);

  async function saveCamera(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingCamera(true);

    const formData = new FormData(event.currentTarget);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cameraDevice: formData.get("cameraDevice"),
        cameraName: formData.get("cameraName"),
      }),
    });

    setSavingCamera(false);
    router.refresh();
    await loadControls();
  }

  async function fetchPreviewFrame() {
    if (captureInFlight.current) {
      return;
    }

    captureInFlight.current = true;
    setPreviewError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/camera/preview`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        setPreviewError(payload.error ?? "Could not capture preview.");
        return;
      }

      const blob = await response.blob();
      const nextUrl = URL.createObjectURL(blob);
      setPreviewUrl((oldUrl) => {
        if (oldUrl) {
          URL.revokeObjectURL(oldUrl);
        }

        return nextUrl;
      });
    } finally {
      captureInFlight.current = false;
    }
  }

  async function loadControls() {
    setLoadingControls(true);
    setControlsError(null);

    const response = await fetch(`/api/projects/${projectId}/camera/controls`);
    const payload = (await response.json()) as {
      controls?: CameraControl[];
      error?: string;
    };

    setLoadingControls(false);

    if (!response.ok) {
      setControls([]);
      setControlsError(payload.error ?? "Could not load camera controls.");
      return;
    }

    setControls(payload.controls ?? []);
  }

  async function updateControl(control: CameraControl, value: string | number | boolean) {
    setControlsError(null);
    const response = await fetch(`/api/projects/${projectId}/camera/controls`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ control: control.id, value }),
    });
    const payload = (await response.json()) as {
      controls?: CameraControl[];
      error?: string;
    };

    if (!response.ok) {
      setControlsError(payload.error ?? `Could not update ${control.name}.`);
      return;
    }

    setControls(payload.controls ?? []);
    if (previewing) {
      await fetchPreviewFrame();
    }
  }

  async function captureTestPhoto() {
    setCapturing(true);
    setCaptureMessage(null);

    const response = await fetch(`/api/projects/${projectId}/photos/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Camera setup test photo." }),
    });
    const payload = (await response.json()) as { savedPath?: string; error?: string };

    setCapturing(false);

    if (!response.ok) {
      setCaptureMessage(payload.error ?? "Could not capture test photo.");
      return;
    }

    setCaptureMessage(`Test photo saved and registered: ${payload.savedPath}`);
    router.refresh();
  }

  useEffect(() => {
    void loadControls();
  }, [projectId]);

  useEffect(() => {
    if (!previewing) {
      return;
    }

    void fetchPreviewFrame();
    const interval = window.setInterval(() => {
      void fetchPreviewFrame();
    }, 2000);

    return () => window.clearInterval(interval);
  }, [previewing, projectId]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  return (
    <div className="grid gap-6">
      <form onSubmit={saveCamera} className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Project Camera</h2>
        <div className="mt-4">
          <CameraSelect defaultDevice={cameraDevice} defaultName={cameraName} />
        </div>
        <button className="button mt-4" disabled={savingCamera}>
          {savingCamera ? "Saving..." : "Save Camera"}
        </button>
      </form>

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-stone-950">Preview</h2>
          <div className="flex gap-2">
            <button type="button" className="button" onClick={() => setPreviewing(true)} disabled={previewing}>
              Start Preview
            </button>
            <button type="button" className="button-secondary" onClick={() => setPreviewing(false)} disabled={!previewing}>
              Pause Preview
            </button>
          </div>
        </div>
        <div className="mt-4 grid min-h-[260px] place-items-center overflow-hidden rounded-md bg-black">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Camera preview" className="max-h-[520px] w-full object-contain" />
          ) : (
            <p className="p-6 text-center text-sm text-stone-300">
              Preview is idle. Start preview to capture temporary frames.
            </p>
          )}
        </div>
        {previewError ? <p className="mt-3 text-sm font-medium text-red-700">{previewError}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="button-secondary" onClick={captureTestPhoto} disabled={capturing}>
            {capturing ? "Capturing..." : "Capture Test Photo"}
          </button>
          {captureMessage ? <span className="text-sm text-stone-600">{captureMessage}</span> : null}
        </div>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-stone-950">Camera Controls</h2>
          <button type="button" className="button-secondary" onClick={loadControls} disabled={loadingControls}>
            {loadingControls ? "Loading..." : "Reset / Reload Current Values"}
          </button>
        </div>
        {controlsError ? <p className="mt-3 text-sm font-medium text-red-700">{controlsError}</p> : null}
        <div className="mt-4 grid gap-4">
          {controls.length === 0 && !controlsError ? (
            <p className="rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-600">
              No writable camera controls were reported for this device.
            </p>
          ) : (
            controls.map((control) => (
              <label key={control.id} className="field">
                {control.name}
                {control.type === "menu" ? (
                  <select
                    className="input"
                    value={String(control.value)}
                    disabled={control.readOnly}
                    onChange={(event) => updateControl(control, event.target.value)}
                  >
                    {control.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : control.type === "bool" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(control.value)}
                    disabled={control.readOnly}
                    onChange={(event) => updateControl(control, event.target.checked)}
                  />
                ) : (
                  <input
                    className="input"
                    type="number"
                    value={String(control.value)}
                    min={control.minimum}
                    max={control.maximum}
                    step={control.step}
                    disabled={control.readOnly}
                    onChange={(event) => updateControl(control, event.target.value)}
                  />
                )}
              </label>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
