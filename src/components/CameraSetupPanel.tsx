"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraSelect } from "@/components/CameraSelect";
import { validateCaptureConfig } from "@/lib/captureValidation";

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

type CameraFormat = {
  pixelFormat: string;
  description: string;
  resolutions: Array<{ width: number; height: number; frameRates: string[] }>;
};

type CameraProfile = {
  id: string;
  name: string;
  cameraDevice: string;
  cameraName: string | null;
  width: number;
  height: number;
  inputFormat: string;
  controlsJson: string | null;
  _count?: { projects: number };
};

export function CameraSetupPanel({
  projectId,
  cameraDevice,
  cameraName,
  cameraProfileId,
  photoIntervalMinutes,
  captureStartAt,
  localPhotoDirectory,
  initialCaptureEnabled,
}: {
  projectId: string;
  cameraDevice: string | null;
  cameraName: string | null;
  cameraProfileId: string | null;
  photoIntervalMinutes: number;
  captureStartAt: string;
  localPhotoDirectory: string;
  initialCaptureEnabled: boolean;
}) {
  const router = useRouter();
  const [savingCamera, setSavingCamera] = useState(false);
  const [selectedCameraDevice, setSelectedCameraDevice] = useState(cameraDevice ?? "");
  const [captureEnabled, setCaptureEnabled] = useState(initialCaptureEnabled);
  const [captureToggleError, setCaptureToggleError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [controls, setControls] = useState<CameraControl[]>([]);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [loadingControls, setLoadingControls] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [formats, setFormats] = useState<CameraFormat[]>([]);
  const [formatsError, setFormatsError] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState("mjpeg");
  const [selectedResolution, setSelectedResolution] = useState("1920x1080");
  const [profiles, setProfiles] = useState<CameraProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState(cameraProfileId ?? "");
  const [profileName, setProfileName] = useState("New camera profile");
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const captureInFlight = useRef(false);

  const selectedFormatData = formats.find((format) => format.pixelFormat === selectedFormat);

  function selectedDimensions() {
    const [width, height] = selectedResolution.split("x").map(Number);
    return {
      width: Number.isFinite(width) ? width : 1920,
      height: Number.isFinite(height) ? height : 1080,
    };
  }

  function currentControlValues() {
    return Object.fromEntries(
      controls
        .filter((control) => !control.readOnly)
        .map((control) => [control.id, control.value]),
    );
  }

  const captureErrors = validateCaptureConfig({
    captureStartAt,
    photoIntervalMinutes,
    cameraDevice: selectedCameraDevice || null,
    localPhotoDirectory,
  });

  async function saveCamera(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCaptureToggleError(null);

    if (captureEnabled && captureErrors.length > 0) {
      setCaptureToggleError(captureErrors.join(" "));
      return;
    }

    setSavingCamera(true);

    const formData = new FormData(event.currentTarget);
    const response = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cameraDevice: formData.get("cameraDevice"),
        cameraName: formData.get("cameraName"),
        cameraProfileId: selectedProfileId || null,
        captureEnabled,
      }),
    });
    const payload = (await response.json()) as { error?: string };

    setSavingCamera(false);

    if (!response.ok) {
      setCaptureToggleError(payload.error ?? "Could not save camera settings.");
      return;
    }

    router.refresh();
    await loadControls();
    await loadFormats();
    await loadProfiles();
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

  async function loadFormats() {
    setFormatsError(null);
    const response = await fetch(`/api/projects/${projectId}/camera/formats`);
    const payload = (await response.json()) as { formats?: CameraFormat[]; error?: string };

    if (!response.ok) {
      setFormats([]);
      setFormatsError(payload.error ?? "Could not load camera formats.");
      return;
    }

    const nextFormats = payload.formats ?? [];
    setFormats(nextFormats);
    const mjpeg = nextFormats.find((format) => format.pixelFormat === "mjpg" || format.pixelFormat === "mjpeg");
    const preferred = mjpeg ?? nextFormats[0];
    if (preferred) {
      setSelectedFormat(preferred.pixelFormat);
      const preferredResolution =
        preferred.resolutions.find((resolution) => resolution.width === 1920 && resolution.height === 1080) ??
        preferred.resolutions[0];
      if (preferredResolution) {
        setSelectedResolution(`${preferredResolution.width}x${preferredResolution.height}`);
      }
    }
  }

  async function loadProfiles() {
    if (!cameraDevice) {
      setProfiles([]);
      return;
    }

    const response = await fetch(`/api/camera-profiles?cameraDevice=${encodeURIComponent(cameraDevice)}`);
    const payload = (await response.json()) as { profiles?: CameraProfile[]; error?: string };

    if (!response.ok) {
      setProfileError(payload.error ?? "Could not load camera profiles.");
      return;
    }

    setProfiles(payload.profiles ?? []);
  }

  async function saveProfile(action: "create" | "update" | "duplicate") {
    setProfileMessage(null);
    setProfileError(null);
    const { width, height } = selectedDimensions();
    const existingProfile = profiles.find((profile) => profile.id === selectedProfileId);
    const body = {
      name:
        action === "duplicate" && existingProfile
          ? `${existingProfile.name} Copy`
          : profileName,
      cameraDevice,
      cameraName,
      width,
      height,
      inputFormat: selectedFormat,
      controls: currentControlValues(),
    };
    const url =
      action === "update" && selectedProfileId
        ? `/api/camera-profiles/${selectedProfileId}`
        : "/api/camera-profiles";
    const method = action === "update" && selectedProfileId ? "PATCH" : "POST";
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as CameraProfile & { error?: string };

    if (!response.ok) {
      setProfileError(payload.error ?? "Could not save profile.");
      return;
    }

    setSelectedProfileId(payload.id);
    setProfileName(payload.name);
    setProfileMessage(action === "update" ? "Profile updated." : "Profile saved.");
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cameraProfileId: payload.id }),
    });
    await loadProfiles();
    router.refresh();
  }

  async function applyProfile() {
    const profile = profiles.find((item) => item.id === selectedProfileId);
    if (!profile) {
      return;
    }

    setSelectedFormat(profile.inputFormat);
    setSelectedResolution(`${profile.width}x${profile.height}`);
    setProfileName(profile.name);
    if (profile.controlsJson) {
      const savedControls = JSON.parse(profile.controlsJson) as Record<string, string | number | boolean>;
      for (const [control, value] of Object.entries(savedControls)) {
        await fetch(`/api/projects/${projectId}/camera/controls`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ control, value }),
        });
      }
      await loadControls();
    }
    setProfileMessage("Profile applied. Save Camera to assign it to the project.");
  }

  async function deleteProfile() {
    if (!selectedProfileId) {
      return;
    }

    setProfileMessage(null);
    setProfileError(null);
    const response = await fetch(`/api/camera-profiles/${selectedProfileId}`, {
      method: "DELETE",
    });
    const payload = (await response.json()) as { error?: string };

    if (!response.ok) {
      setProfileError(payload.error ?? "Could not delete profile.");
      return;
    }

    setSelectedProfileId("");
    setProfileMessage("Profile deleted.");
    await loadProfiles();
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
    void loadFormats();
    void loadProfiles();
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
          <CameraSelect
            defaultDevice={cameraDevice}
            defaultName={cameraName}
            onDeviceChange={setSelectedCameraDevice}
          />
        </div>

        <div className="mt-4 grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
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
          {captureToggleError ? (
            <p className="text-sm font-medium text-red-700">{captureToggleError}</p>
          ) : null}
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
          <h2 className="text-lg font-semibold text-stone-950">Format and Profile</h2>
          <button type="button" className="button-secondary" onClick={loadFormats}>
            Reload Formats
          </button>
        </div>
        {formatsError ? <p className="mt-3 text-sm font-medium text-red-700">{formatsError}</p> : null}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="field">
            Input format
            <select
              className="input"
              value={selectedFormat}
              onChange={(event) => {
                const nextFormat = event.target.value;
                setSelectedFormat(nextFormat);
                const format = formats.find((item) => item.pixelFormat === nextFormat);
                const resolution = format?.resolutions[0];
                if (resolution) {
                  setSelectedResolution(`${resolution.width}x${resolution.height}`);
                }
              }}
            >
              {formats.length === 0 ? (
                <option value={selectedFormat}>{selectedFormat}</option>
              ) : (
                formats.map((format) => (
                  <option key={format.pixelFormat} value={format.pixelFormat}>
                    {format.pixelFormat.toUpperCase()} - {format.description}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="field">
            Resolution
            <select
              className="input"
              value={selectedResolution}
              onChange={(event) => setSelectedResolution(event.target.value)}
            >
              {(selectedFormatData?.resolutions ?? [{ width: 1920, height: 1080, frameRates: [] }]).map((resolution) => (
                <option key={`${resolution.width}x${resolution.height}`} value={`${resolution.width}x${resolution.height}`}>
                  {resolution.width} x {resolution.height}
                  {resolution.frameRates.length > 0 ? ` (${resolution.frameRates.join(", ")})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="field">
            Camera profile
            <select
              className="input"
              value={selectedProfileId}
              onChange={(event) => {
                setSelectedProfileId(event.target.value);
                const profile = profiles.find((item) => item.id === event.target.value);
                if (profile) {
                  setProfileName(profile.name);
                }
              }}
            >
              <option value="">Use current unsaved camera settings</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} ({profile.width}x{profile.height} {profile.inputFormat})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Profile name
            <input
              className="input"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="button-secondary" onClick={applyProfile} disabled={!selectedProfileId}>
              Apply Existing Profile
            </button>
            <button type="button" className="button-secondary" onClick={() => saveProfile("create")} disabled={!cameraDevice}>
              Save Current Setup as Profile
            </button>
            <button type="button" className="button-secondary" onClick={() => saveProfile("update")} disabled={!selectedProfileId}>
              Update Profile
            </button>
            <button type="button" className="button-secondary" onClick={() => saveProfile("duplicate")} disabled={!selectedProfileId}>
              Duplicate Profile
            </button>
            <button type="button" className="button-secondary" onClick={deleteProfile} disabled={!selectedProfileId}>
              Delete Profile
            </button>
          </div>
          {profileMessage ? <p className="text-sm font-medium text-emerald-700">{profileMessage}</p> : null}
          {profileError ? <p className="text-sm font-medium text-red-700">{profileError}</p> : null}
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
