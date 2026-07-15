"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CapturePhotoButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  async function waitForRemoteJob(jobId: string) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const response = await fetch(`/api/projects/${projectId}/captures/${jobId}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        status?: string;
        photoId?: string | null;
        errorMessage?: string | null;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Could not read capture job status.");
      }
      if (payload.status === "completed") {
        return payload.photoId ? "Remote capture saved." : "Remote capture completed.";
      }
      if (payload.status === "failed") {
        throw new Error(payload.errorMessage ?? "Remote capture failed.");
      }
      setMessage(payload.status === "claimed" ? "Capturing on node..." : "Queued on node...");
    }
    throw new Error("Remote capture is still running.");
  }

  async function capture() {
    setCapturing(true);
    setMessage(null);

    const response = await fetch(`/api/projects/${projectId}/captures`, {
      method: "POST",
    });
    const payload = (await response.json()) as {
      mode?: string;
      jobId?: string;
      savedPath?: string;
      error?: string;
    };

    setCapturing(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Could not capture photo");
      return;
    }

    if (payload.mode === "remote-job" && payload.jobId) {
      setMessage("Queued on node...");
      try {
        setCapturing(true);
        setMessage(await waitForRemoteJob(payload.jobId));
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Remote capture failed.");
      } finally {
        setCapturing(false);
      }
      return;
    }

    setMessage(payload.savedPath ? `Saved ${payload.savedPath}` : "Capture saved.");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="button"
        onClick={capture}
        disabled={capturing}
      >
        {capturing ? "Capturing..." : "Capture Photo"}
      </button>
      {message ? <span className="text-sm text-stone-600">{message}</span> : null}
    </div>
  );
}
