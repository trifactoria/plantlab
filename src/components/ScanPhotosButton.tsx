"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ScanPhotosButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function scan() {
    setScanning(true);
    setMessage(null);

    const response = await fetch(`/api/projects/${projectId}/photos/scan`, {
      method: "POST",
    });
    const payload = (await response.json()) as { imported?: number; error?: string };

    setScanning(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Could not scan directory");
      return;
    }

    setMessage(`${payload.imported ?? 0} new photo${payload.imported === 1 ? "" : "s"} imported`);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="button-secondary" onClick={scan} disabled={scanning}>
        {scanning ? "Scanning..." : "Scan Photo Directory"}
      </button>
      {message ? <span className="text-sm text-stone-600">{message}</span> : null}
    </div>
  );
}
