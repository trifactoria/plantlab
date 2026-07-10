"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CapturePhotoButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  async function capture() {
    setCapturing(true);
    setMessage(null);

    const response = await fetch(`/api/projects/${projectId}/photos/capture`, {
      method: "POST",
    });
    const payload = (await response.json()) as {
      savedPath?: string;
      error?: string;
    };

    setCapturing(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Could not capture photo");
      return;
    }

    setMessage(`Saved ${payload.savedPath ?? "photo"}`);
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
