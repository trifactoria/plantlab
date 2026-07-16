"use client";

import { useState } from "react";
import Image from "next/image";
import type { FleetCameraSummary } from "@/lib/operations/fleetHardware";

type TestMode = { width: number; height: number; inputFormat: string; frameRate: string | null } | null;

type TestResult = {
  mode: "remote-node" | "local";
  status: string;
  jobId: string | null;
  reused: boolean;
  requestedMode: TestMode;
  effectiveMode: TestMode;
  fallbackUsed: boolean | null;
  sourceCaptureId: string | null;
};

function modeText(mode: TestMode): string {
  if (!mode) return "-";
  return `${mode.width} × ${mode.height} · ${mode.inputFormat.toUpperCase()}${mode.frameRate ? ` · ${mode.frameRate} fps` : ""}`;
}

/**
 * Canonical camera test capture. Routes through the fleet test-capture
 * operation, which executes on the camera's owning node for a remote camera
 * (never coordinator-local FFmpeg), and reports the execution node, status,
 * requested vs effective mode, fallback use, and a validated image preview.
 */
export function CameraTestCaptureAction({ camera }: { camera: FleetCameraSummary }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runTest() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/hardware/cameras/test-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId: camera.id, waitForCompletion: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "Test capture failed.");
        return;
      }
      setResult(body.result as TestResult);
    } catch {
      setError("Could not reach the coordinator.");
    } finally {
      setRunning(false);
    }
  }

  const succeeded = result?.status === "completed" || result?.status === "succeeded";

  return (
    <div className="grid gap-3">
      <button type="button" className="button w-fit" onClick={runTest} disabled={running} data-testid="camera-test-capture">
        {running ? `Capturing on ${camera.node.name}...` : "Test Capture"}
      </button>

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      {result ? (
        <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm" data-testid="camera-test-result">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="font-medium text-stone-950">Execution node</dt>
              <dd className="text-stone-600">
                {camera.node.name} ({result.mode === "remote-node" ? "remote" : "local"})
              </dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Status</dt>
              <dd className={succeeded ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>{result.status}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Requested mode</dt>
              <dd className="text-stone-600">{modeText(result.requestedMode)}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Effective mode</dt>
              <dd className="text-stone-600">{modeText(result.effectiveMode)}</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Fallback used</dt>
              <dd className={result.fallbackUsed ? "font-medium text-amber-700" : "text-stone-600"}>
                {result.fallbackUsed === null ? "unknown" : result.fallbackUsed ? "yes" : "no"}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-stone-950">Validation</dt>
              <dd className={succeeded ? "text-emerald-700" : "text-amber-700"}>{succeeded ? "captured" : result.status}</dd>
            </div>
          </dl>

          {result.sourceCaptureId ? (
            <div className="relative aspect-video w-full max-w-md overflow-hidden rounded-md border border-stone-200 bg-black">
              <Image
                src={`/api/hardware/cameras/captures/${result.sourceCaptureId}/file`}
                alt={`Test capture from ${camera.displayName}`}
                fill
                sizes="(max-width: 640px) 100vw, 448px"
                className="object-contain"
                unoptimized
              />
            </div>
          ) : succeeded ? (
            <p className="text-xs text-stone-500">Capture completed; preview is not available for this result.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
