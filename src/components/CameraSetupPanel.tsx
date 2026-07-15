"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraSelect } from "@/components/CameraSelect";
import { CaptureSourceSelect } from "@/components/CaptureSourceSelect";
import {
  CaptureScheduleFields,
  captureSchedulePayload,
  initialScheduleValue,
  type CaptureScheduleValue,
} from "@/components/CaptureScheduleFields";
import { FocusInspector } from "@/components/FocusInspector";
import { detectAutofocusSupport, type AutofocusPreviousState } from "@/lib/autofocus";
import type { CalibrationResult } from "@/lib/calibration";
import { matchSavedCamera } from "@/lib/cameraIdentityMatch";
import { validateCaptureConfig } from "@/lib/captureValidation";
import type { ResolutionTestResult } from "@/lib/resolutionCompare";
import { safeTimeInputToMinutes } from "@/lib/timezone";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CameraControl = {
  id: string;
  name: string;
  type: "int" | "bool" | "menu" | "unknown";
  value: number | boolean | string;
  minimum?: number;
  maximum?: number;
  step?: number;
  readOnly: boolean;
  inactive: boolean;
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
  cameraStableId,
  cameraProfileId,
  captureSourceId,
  localControlsEnabled,
  photoIntervalMinutes,
  captureStartAt,
  timeZone,
  captureWindowEnabled,
  captureWindowStartMinutes,
  captureWindowEndMinutes,
  localPhotoDirectory,
  initialCaptureEnabled,
  isTestProject,
}: {
  projectId: string;
  cameraDevice: string | null;
  cameraName: string | null;
  cameraStableId: string | null;
  cameraProfileId: string | null;
  captureSourceId: string | null;
  localControlsEnabled: boolean;
  photoIntervalMinutes: number;
  captureStartAt: string;
  timeZone: string;
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
  localPhotoDirectory: string;
  initialCaptureEnabled: boolean;
  isTestProject: boolean;
}) {
  const router = useRouter();
  const [savingCamera, setSavingCamera] = useState(false);
  const [cameraSaveError, setCameraSaveError] = useState<string | null>(null);
  const [selectedCameraDevice, setSelectedCameraDevice] = useState(cameraDevice ?? "");
  const [selectedCameraStableId, setSelectedCameraStableId] = useState<string | null>(cameraStableId);
  const [selectedCaptureSourceId, setSelectedCaptureSourceId] = useState(captureSourceId ?? "");
  const [savingCaptureSource, setSavingCaptureSource] = useState(false);
  const [captureSourceMessage, setCaptureSourceMessage] = useState<string | null>(null);
  const [movedCameraMatch, setMovedCameraMatch] = useState<{ device: string } | null>(null);
  const [updatingMovedCamera, setUpdatingMovedCamera] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState(initialCaptureEnabled);
  const [schedule, setSchedule] = useState<CaptureScheduleValue>(() =>
    initialScheduleValue({
      timeZone,
      photoIntervalMinutes,
      captureStartAt,
      captureWindowEnabled,
      captureWindowStartMinutes,
      captureWindowEndMinutes,
    }),
  );
  const [savingSchedule, setSavingSchedule] = useState(false);
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
  const [autofocusRunning, setAutofocusRunning] = useState(false);
  const [autofocusMessage, setAutofocusMessage] = useState<string | null>(null);
  const [autofocusError, setAutofocusError] = useState<string | null>(null);
  const [autofocusSettleSeconds, setAutofocusSettleSeconds] = useState(5);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrationResult, setCalibrationResult] = useState<CalibrationResult | null>(null);
  const [calibrationBeforeUrl, setCalibrationBeforeUrl] = useState<string | null>(null);
  const [calibrationAfterUrl, setCalibrationAfterUrl] = useState<string | null>(null);
  const [calibrationChoice, setCalibrationChoice] = useState<"leave-automatic" | "locked" | null>(null);
  const [comparingResolutions, setComparingResolutions] = useState(false);
  const [resolutionResults, setResolutionResults] = useState<ResolutionTestResult[]>([]);
  const [resolutionCompareError, setResolutionCompareError] = useState<string | null>(null);
  const [verifyingCapture, setVerifyingCapture] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    requestedWidth: number;
    requestedHeight: number;
    actualWidth: number;
    actualHeight: number;
    matched: boolean;
    byteSize: number;
  } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const captureInFlight = useRef(false);

  const selectedFormatData = formats.find((format) => format.pixelFormat === selectedFormat);
  const autofocusSupport = detectAutofocusSupport(controls);
  const activeProfileName = profiles.find((profile) => profile.id === selectedProfileId)?.name ?? "Unsaved setup";
  const focusModeLabel = !autofocusSupport.supported
    ? "Manual"
    : Boolean(autofocusSupport.autofocusControl?.value)
      ? "Continuous autofocus"
      : "Manual (locked)";

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
    captureStartAt: schedule.captureStartAt,
    photoIntervalMinutes: Number.parseInt(schedule.photoIntervalMinutes, 10),
    cameraDevice: selectedCaptureSourceId ? "capture-source" : selectedCameraDevice || null,
    localPhotoDirectory,
    timeZone: schedule.timeZone,
    captureWindowEnabled: schedule.captureWindowEnabled,
    captureWindowStartMinutes: schedule.captureWindowEnabled ? safeTimeInputToMinutes(schedule.captureWindowStart) : null,
    captureWindowEndMinutes: schedule.captureWindowEnabled ? safeTimeInputToMinutes(schedule.captureWindowEnd) : null,
    isTestProject,
  });

  async function saveCaptureSource() {
    setCaptureSourceMessage(null);
    setSavingCaptureSource(true);
    const response = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        captureSourceId: selectedCaptureSourceId || "",
        cameraDevice: selectedCaptureSourceId ? null : undefined,
      }),
    });
    const payload = (await response.json()) as { error?: string };
    setSavingCaptureSource(false);

    if (!response.ok) {
      setCaptureSourceMessage(payload.error ?? "Could not save capture source.");
      return;
    }

    setCaptureSourceMessage(selectedCaptureSourceId ? "Capture source saved." : "Capture source cleared.");
    router.refresh();
  }

  async function saveCamera(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCameraSaveError(null);
    setSavingCamera(true);

    const formData = new FormData(event.currentTarget);
    const response = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cameraDevice: formData.get("cameraDevice"),
        cameraName: formData.get("cameraName"),
        cameraStableId: selectedCameraStableId,
        cameraProfileId: selectedProfileId || null,
        captureSourceId: "",
      }),
    });
    const payload = (await response.json()) as { error?: string };

    setSavingCamera(false);

    if (!response.ok) {
      setCameraSaveError(payload.error ?? "Could not save camera settings.");
      return;
    }

    router.refresh();
    await loadControls();
    await loadFormats();
    await loadProfiles();
  }

  async function saveCaptureSchedule() {
    setCaptureToggleError(null);

    if (captureEnabled && captureErrors.length > 0) {
      setCaptureToggleError(captureErrors.join(" "));
      return;
    }

    setSavingSchedule(true);
    const response = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...captureSchedulePayload(schedule),
        captureEnabled: isTestProject ? false : captureEnabled,
      }),
    });
    const payload = (await response.json()) as { error?: string };
    setSavingSchedule(false);

    if (!response.ok) {
      setCaptureToggleError(payload.error ?? "Could not save capture schedule.");
      return;
    }

    router.refresh();
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
      cameraStableId: selectedCameraStableId,
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

    const response = await fetch(`/api/projects/${projectId}/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Camera setup test photo." }),
    });
    const payload = (await response.json()) as { mode?: string; jobId?: string; savedPath?: string; error?: string };

    setCapturing(false);

    if (!response.ok) {
      setCaptureMessage(payload.error ?? "Could not capture test photo.");
      return;
    }

    if (payload.mode === "remote-job" && payload.jobId) {
      setCaptureMessage("Queued on node...");
      setCapturing(true);
      try {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          await sleep(1500);
          const statusResponse = await fetch(`/api/projects/${projectId}/captures/${payload.jobId}`, { cache: "no-store" });
          const statusPayload = (await statusResponse.json()) as { status?: string; error?: string; errorMessage?: string | null };
          if (!statusResponse.ok) throw new Error(statusPayload.error ?? "Could not read capture job status.");
          if (statusPayload.status === "completed") {
            setCaptureMessage("Remote test photo saved and registered.");
            router.refresh();
            return;
          }
          if (statusPayload.status === "failed") throw new Error(statusPayload.errorMessage ?? "Remote test capture failed.");
          setCaptureMessage(statusPayload.status === "claimed" ? "Capturing on node..." : "Queued on node...");
        }
        setCaptureMessage("Remote capture is still running.");
      } catch (error) {
        setCaptureMessage(error instanceof Error ? error.message : "Remote test capture failed.");
      } finally {
        setCapturing(false);
      }
      return;
    }

    setCaptureMessage(payload.savedPath ? `Test photo saved and registered: ${payload.savedPath}` : "Test photo saved and registered.");
    router.refresh();
  }

  async function callAutofocus(body: Record<string, unknown>) {
    const response = await fetch(`/api/projects/${projectId}/camera/autofocus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Autofocus operation failed.");
    }

    return payload;
  }

  async function runAutofocusNow() {
    setAutofocusRunning(true);
    setAutofocusError(null);
    setAutofocusMessage("Enabling autofocus...");
    setPreviewing(true);

    let previous: AutofocusPreviousState | undefined;

    try {
      const started = await callAutofocus({ phase: "start" });
      previous = started.previous as AutofocusPreviousState;
      setControls(started.controls ?? []);

      setAutofocusMessage(`Settling for ${autofocusSettleSeconds}s while autofocus adjusts...`);
      await sleep(autofocusSettleSeconds * 1000);

      const locked = await callAutofocus({ phase: "lock" });
      setControls(locked.controls ?? []);
      setAutofocusMessage(
        locked.manualFocusValue !== null && locked.manualFocusValue !== undefined
          ? `Autofocus locked. Manual focus value: ${locked.manualFocusValue}. Use "Update Profile" below to save it.`
          : "Autofocus locked.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Autofocus Now failed.";

      if (previous) {
        try {
          const restored = await callAutofocus({ phase: "restore", previous });
          setControls(restored.controls ?? []);
        } catch {
          // Best-effort restore; the error above is still surfaced to the user.
        }
      }

      setAutofocusError(message);
      setAutofocusMessage(null);
    } finally {
      setAutofocusRunning(false);
    }
  }

  async function callCalibrate(body: Record<string, unknown>) {
    const response = await fetch(`/api/projects/${projectId}/camera/calibrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Auto Calibrate failed.");
    }

    return payload;
  }

  async function runAutoCalibrate() {
    setCalibrating(true);
    setCalibrationError(null);
    setCalibrationResult(null);
    setCalibrationBeforeUrl(null);
    setCalibrationAfterUrl(null);
    setCalibrationChoice(null);

    try {
      const payload = await callCalibrate({ phase: "run" });
      const result = payload.result as CalibrationResult;
      setCalibrationResult(result);
      setCalibrationBeforeUrl(`data:image/jpeg;base64,${payload.before}`);
      setCalibrationAfterUrl(`data:image/jpeg;base64,${payload.after}`);
      setControls(result.controls ?? []);
      setSelectedFormat(result.format);
      setSelectedResolution(`${result.width}x${result.height}`);
    } catch (error) {
      setCalibrationError(error instanceof Error ? error.message : "Auto Calibrate failed.");
    } finally {
      setCalibrating(false);
    }
  }

  async function chooseCalibrationAutoModes(lock: boolean) {
    if (!calibrationResult) {
      return;
    }

    try {
      const payload = await callCalibrate({
        phase: "lock-auto-modes",
        lockWhiteBalance: lock && calibrationResult.autoWhiteBalanceAvailable,
        lockExposure: lock && calibrationResult.autoExposureAvailable,
      });
      setControls(payload.controls ?? []);
      setCalibrationChoice(lock ? "locked" : "leave-automatic");
    } catch (error) {
      setCalibrationError(error instanceof Error ? error.message : "Could not update auto modes.");
    }
  }

  async function compareResolutions() {
    setComparingResolutions(true);
    setResolutionCompareError(null);
    setResolutionResults([]);

    try {
      const response = await fetch(`/api/projects/${projectId}/camera/resolution-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pixelFormat: selectedFormat }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Resolution comparison failed.");
      }

      setResolutionResults(payload.results ?? []);
    } catch (error) {
      setResolutionCompareError(error instanceof Error ? error.message : "Resolution comparison failed.");
    } finally {
      setComparingResolutions(false);
    }
  }

  function useResolution(width: number, height: number) {
    setSelectedResolution(`${width}x${height}`);
  }

  async function verifyFullResolutionCapture() {
    setVerifyingCapture(true);
    setVerifyError(null);
    setVerifyResult(null);

    try {
      const { width, height } = selectedDimensions();
      const response = await fetch(`/api/projects/${projectId}/camera/verify-capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width, height, inputFormat: selectedFormat }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Full-resolution verification failed.");
      }

      setVerifyResult(payload);
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "Full-resolution verification failed.");
    } finally {
      setVerifyingCapture(false);
    }
  }

  async function checkForMovedCamera() {
    if (!cameraStableId) {
      return;
    }

    const response = await fetch("/api/cameras");
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { cameras?: Array<{ device: string; stableId: string | null }> };
    const match = matchSavedCamera(payload.cameras ?? [], { stableId: cameraStableId, device: cameraDevice });

    if (match.devicePathChanged && match.matched) {
      setMovedCameraMatch({ device: match.matched.device });
    }
  }

  async function updateToMovedCamera() {
    if (!movedCameraMatch) {
      return;
    }

    setUpdatingMovedCamera(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cameraDevice: movedCameraMatch.device, cameraStableId }),
    });
    setUpdatingMovedCamera(false);
    setMovedCameraMatch(null);
    router.refresh();
  }

  useEffect(() => {
    if (!localControlsEnabled) {
      return;
    }

    void loadControls();
    void loadFormats();
    void loadProfiles();
    void checkForMovedCamera();
  }, [localControlsEnabled, projectId]);

  useEffect(() => {
    if (!localControlsEnabled) {
      return;
    }

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
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-950">Project Capture Source</h2>
            {!localControlsEnabled ? (
              <p className="mt-1 text-sm text-stone-600">
                Local V4L2 camera controls are unavailable on this coordinator, but configured cameras from attached nodes are selectable here.
              </p>
            ) : null}
          </div>
          <button type="button" className="button" onClick={saveCaptureSource} disabled={savingCaptureSource}>
            {savingCaptureSource ? "Saving..." : "Save Capture Source"}
          </button>
        </div>
        <div className="mt-4">
          <CaptureSourceSelect defaultCaptureSourceId={captureSourceId} onChange={setSelectedCaptureSourceId} />
        </div>
        {!localControlsEnabled ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-emerald-950">Attached-node capture</p>
                <p className="mt-1 text-sm text-emerald-900">
                  Camera setup on the coordinator uses configured Capture Sources from attached nodes.
                  Local device paths from the coordinator are not required for this project.
                </p>
              </div>
              <button type="button" className="button" onClick={captureTestPhoto} disabled={capturing || !selectedCaptureSourceId}>
                {capturing ? "Capturing..." : "Capture Test Photo"}
              </button>
            </div>
            {captureMessage ? <p className="mt-3 text-sm font-medium text-emerald-950">{captureMessage}</p> : null}
          </div>
        ) : null}
        {captureSourceMessage ? <p className="mt-3 text-sm font-medium text-stone-700">{captureSourceMessage}</p> : null}
      </div>

      {localControlsEnabled ? (
        <>
      {/* 1. Camera and Profile */}
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Camera and Profile</h2>

        {movedCameraMatch ? (
          <div className="mt-3 grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-950">
            <p className="text-sm">
              This camera was previously at <code>{cameraDevice}</code> but was just found at{" "}
              <code>{movedCameraMatch.device}</code> (matched by its stable USB identity, not just the
              device number). Update this project to use the new path?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="button-secondary"
                onClick={updateToMovedCamera}
                disabled={updatingMovedCamera}
              >
                {updatingMovedCamera ? "Updating..." : "Update Project"}
              </button>
              <button type="button" className="button-secondary" onClick={() => setMovedCameraMatch(null)}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        <form onSubmit={saveCamera} className="mt-4 grid gap-4">
          <CameraSelect
            defaultDevice={cameraDevice}
            defaultName={cameraName}
            onDeviceChange={setSelectedCameraDevice}
            onCameraChange={(camera) => setSelectedCameraStableId(camera?.stableId ?? null)}
          />
          {cameraSaveError ? <p className="text-sm font-medium text-red-700">{cameraSaveError}</p> : null}
          <button className="button w-fit" disabled={savingCamera}>
            {savingCamera ? "Saving..." : "Save Camera"}
          </button>
        </form>

        <div className="mt-5 border-t border-stone-200 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-stone-800">Format and resolution</p>
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

        <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-stone-800">Compare resolutions</p>
            <button
              type="button"
              className="button-secondary"
              onClick={compareResolutions}
              disabled={comparingResolutions}
            >
              {comparingResolutions ? "Capturing..." : "Compare Resolutions"}
            </button>
          </div>
          <p className="mt-1 text-xs text-stone-600">
            Captures one temporary test frame at each supported resolution (1920x1080, 2560x1440,
            3840x2160), one at a time. Not saved as project photos.
          </p>
          {resolutionCompareError ? (
            <p className="mt-2 text-sm font-medium text-red-700">{resolutionCompareError}</p>
          ) : null}
          {resolutionResults.length > 0 ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {resolutionResults.map((result) => (
                <div key={`${result.width}x${result.height}`} className="grid gap-1 rounded-md border border-stone-200 bg-white p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:image/jpeg;base64,${result.imageBase64}`}
                    alt={`${result.width}x${result.height} test capture`}
                    className="aspect-video w-full rounded object-cover"
                  />
                  <p className="text-xs font-medium text-stone-800">
                    {result.width} x {result.height}
                  </p>
                  <p className="text-xs text-stone-600">
                    {(result.byteSize / 1024).toFixed(0)} KB - {result.durationMs}ms
                  </p>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => useResolution(result.width, result.height)}
                  >
                    Use This Resolution
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-stone-800">Verify full-resolution capture</p>
            <button
              type="button"
              className="button-secondary"
              onClick={verifyFullResolutionCapture}
              disabled={verifyingCapture}
            >
              {verifyingCapture ? "Capturing..." : "Verify Full-Resolution Capture"}
            </button>
          </div>
          <p className="mt-1 text-xs text-stone-600">
            Captures one temporary frame at the selected format/resolution and reads back its actual
            written pixel dimensions - a camera can silently fall back to a lower mode than requested.
          </p>
          {verifyError ? <p className="mt-2 text-sm font-medium text-red-700">{verifyError}</p> : null}
          {verifyResult ? (
            <dl
              data-testid="verify-capture-result"
              className={`mt-3 grid grid-cols-2 gap-2 rounded-md border p-3 text-xs sm:grid-cols-4 ${
                verifyResult.matched ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
              }`}
            >
              <div>
                <dt className="font-medium text-stone-800">Requested</dt>
                <dd>
                  {verifyResult.requestedWidth} x {verifyResult.requestedHeight}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-stone-800">Actual</dt>
                <dd>
                  {verifyResult.actualWidth} x {verifyResult.actualHeight}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-stone-800">Result</dt>
                <dd className={verifyResult.matched ? "text-emerald-700" : "text-amber-700"}>
                  {verifyResult.matched ? "Matched requested resolution" : "Camera fell back to a different resolution"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-stone-800">File size</dt>
                <dd>{(verifyResult.byteSize / 1024).toFixed(0)} KB</dd>
              </div>
            </dl>
          ) : null}
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
      </div>

      {/* 2. Preview and Focus */}
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-stone-950">Preview and Focus</h2>
          <div className="flex gap-2">
            <button type="button" className="button" onClick={() => setPreviewing(true)} disabled={previewing}>
              Start Preview
            </button>
            <button type="button" className="button-secondary" onClick={() => setPreviewing(false)} disabled={!previewing}>
              Pause Preview
            </button>
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-stone-600 sm:grid-cols-4">
          <div>
            <dt className="font-medium text-stone-800">Format</dt>
            <dd>{selectedFormat}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-800">Resolution</dt>
            <dd>{selectedResolution}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-800">Profile</dt>
            <dd>{activeProfileName}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-800">Focus mode</dt>
            <dd>{focusModeLabel}</dd>
          </div>
        </dl>

        <div className="mt-4 grid min-h-[260px] place-items-center overflow-hidden rounded-md bg-black">
          {previewUrl ? (
            <FocusInspector imageUrl={previewUrl} />
          ) : (
            <p className="p-6 text-center text-sm text-stone-300">
              Preview is idle. Start preview to capture temporary frames.
            </p>
          )}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Click the preview to open a Focus inspection inset (magnified crop with a relative
          sharpness indicator). This only inspects the image - it does not change the camera&apos;s
          autofocus target.
        </p>
        {previewError ? <p className="mt-3 text-sm font-medium text-red-700">{previewError}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="button-secondary" onClick={captureTestPhoto} disabled={capturing}>
            {capturing ? "Capturing..." : "Capture Test Photo"}
          </button>
          {captureMessage ? <span className="text-sm text-stone-600">{captureMessage}</span> : null}
        </div>

        {autofocusSupport.supported ? (
          <div className="mt-4 grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="button-secondary"
                onClick={runAutofocusNow}
                disabled={autofocusRunning}
              >
                {autofocusRunning ? "Autofocusing..." : "Autofocus Now"}
              </button>
              <label className="flex items-center gap-2 text-sm text-stone-600">
                Settle seconds
                <input
                  className="input w-20"
                  type="number"
                  min={1}
                  value={autofocusSettleSeconds}
                  disabled={autofocusRunning}
                  onChange={(event) => setAutofocusSettleSeconds(Number(event.target.value) || 1)}
                />
              </label>
            </div>
            <p className="text-xs text-stone-600">
              Enables continuous autofocus, keeps previewing while it settles, then disables it again
              to lock the resulting manual focus value.
            </p>
            {autofocusMessage ? <p className="text-sm text-stone-700">{autofocusMessage}</p> : null}
            {autofocusError ? <p className="text-sm font-medium text-red-700">{autofocusError}</p> : null}
          </div>
        ) : null}
      </div>

      {/* 3. Quick Calibration */}
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Quick Calibration</h2>
        <p className="mt-2 text-sm text-stone-600">
          Before calibrating, fix the camera&apos;s physical position and make sure grow-light
          conditions are set the way they&apos;ll stay - Auto Calibrate tunes settings for the
          current scene and lighting, so changing either afterward may require re-running it.
        </p>
        <button type="button" className="button mt-4" onClick={runAutoCalibrate} disabled={calibrating}>
          {calibrating ? "Calibrating..." : "Auto Calibrate"}
        </button>
        {calibrationError ? <p className="mt-3 text-sm font-medium text-red-700">{calibrationError}</p> : null}

        {calibrationResult ? (
          <div className="mt-4 grid gap-4">
            <ul className="grid gap-1 text-sm text-stone-600">
              {calibrationResult.steps.map((step) => (
                <li key={step.step}>
                  {step.applied ? "✓" : "–"} {step.step}
                  {step.detail ? `: ${step.detail}` : ""}
                </li>
              ))}
            </ul>

            {calibrationBeforeUrl && calibrationAfterUrl ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Before</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={calibrationBeforeUrl} alt="Before calibration" className="rounded-md border border-stone-200" />
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">After</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={calibrationAfterUrl} alt="After calibration" className="rounded-md border border-stone-200" />
                </div>
              </div>
            ) : null}

            {(calibrationResult.autoExposureAvailable || calibrationResult.autoWhiteBalanceAvailable) &&
            !calibrationChoice ? (
              <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
                <p className="text-sm text-stone-700">
                  Leave exposure and white balance automatic, or lock their current values?
                </p>
                <div className="flex gap-2">
                  <button type="button" className="button-secondary" onClick={() => chooseCalibrationAutoModes(false)}>
                    Leave Automatic
                  </button>
                  <button type="button" className="button-secondary" onClick={() => chooseCalibrationAutoModes(true)}>
                    Lock Current Values
                  </button>
                </div>
              </div>
            ) : null}
            {calibrationChoice ? (
              <p className="text-sm text-stone-600">
                {calibrationChoice === "locked"
                  ? "Exposure and white balance locked to their calibrated values."
                  : "Exposure and white balance left automatic."}{" "}
                Use &quot;Save Current Setup as Profile&quot; above to save this result as a named
                camera profile.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
        </>
      ) : null}

      {/* 4. Capture Schedule */}
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Capture Schedule</h2>
        <div className="mt-4 grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
            <input
              type="checkbox"
              checked={captureEnabled}
              onChange={(event) => setCaptureEnabled(event.target.checked)}
              disabled={isTestProject}
            />
            Enable scheduled capture
          </label>
          {isTestProject ? (
            <p className="text-sm text-amber-800">Test projects cannot enable scheduled capture.</p>
          ) : null}
          <CaptureScheduleFields
            value={schedule}
            onChange={(patch) => setSchedule((current) => ({ ...current, ...patch }))}
          />
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
        <button
          type="button"
          className="button mt-4"
          onClick={saveCaptureSchedule}
          disabled={savingSchedule}
        >
          {savingSchedule ? "Saving..." : "Save Schedule"}
        </button>
      </div>

      {/* 5. Advanced Camera Controls (collapsed by default) */}
      <details className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <summary className="cursor-pointer text-lg font-semibold text-stone-950">
          Advanced Camera Controls
        </summary>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-stone-600">Every writable control this camera reports.</p>
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
            controls.map((control) => {
              const disabled = control.readOnly || control.inactive;
              const hasRange =
                control.type === "int" &&
                typeof control.minimum === "number" &&
                typeof control.maximum === "number";

              return (
                <label key={control.id} className="field">
                  {control.name}
                  {control.type === "menu" ? (
                    <select
                      className="input"
                      value={String(control.value)}
                      disabled={disabled}
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
                      disabled={disabled}
                      onChange={(event) => updateControl(control, event.target.checked)}
                    />
                  ) : hasRange ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        className="flex-1"
                        value={String(control.value)}
                        min={control.minimum}
                        max={control.maximum}
                        step={control.step}
                        disabled={disabled}
                        onChange={(event) => updateControl(control, event.target.value)}
                      />
                      <input
                        className="input w-24"
                        type="number"
                        value={String(control.value)}
                        min={control.minimum}
                        max={control.maximum}
                        step={control.step}
                        disabled={disabled}
                        onChange={(event) => updateControl(control, event.target.value)}
                      />
                    </div>
                  ) : (
                    <input
                      className="input"
                      type="number"
                      value={String(control.value)}
                      min={control.minimum}
                      max={control.maximum}
                      step={control.step}
                      disabled={disabled}
                      onChange={(event) => updateControl(control, event.target.value)}
                    />
                  )}
                  {control.inactive && !control.readOnly ? (
                    <span className="text-xs font-normal text-amber-700">
                      Inactive - a related automatic mode control may need to change first (for
                      example, disabling autofocus, auto white balance, or auto exposure).
                    </span>
                  ) : null}
                </label>
              );
            })
          )}
        </div>
      </details>
    </div>
  );
}
