"use client";

import { useEffect, useState } from "react";

export type AvailableCaptureSource = {
  id: string;
  name: string;
  mode: "local" | "remote-node";
  node: { id: string; name: string; role: string } | null;
  logicalCameraName: string | null;
  available: boolean;
  retired: boolean;
  width: number;
  height: number;
  selectable: boolean;
  recentError: string | null;
};

function groupLabel(source: AvailableCaptureSource): string {
  return source.node?.name ?? "Coordinator";
}

/**
 * Distributed CaptureSource picker: replaces the old local-only V4L2
 * CameraSelect for project creation/settings. Lists every configured
 * CaptureSource (local shelf cameras on the coordinator and remote node
 * cameras alike, via GET /api/capture-sources/available) grouped by node,
 * and submits captureSourceId rather than a raw /dev/video* path. Retired
 * and currently-unavailable sources stay visible for context but are not
 * selectable for a new/updated project.
 */
export function CaptureSourceSelect({
  defaultCaptureSourceId,
  onChange,
}: {
  defaultCaptureSourceId?: string | null;
  onChange?: (captureSourceId: string) => void;
}) {
  const [sources, setSources] = useState<AvailableCaptureSource[]>([]);
  const [selected, setSelected] = useState(defaultCaptureSourceId ?? "");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    onChange?.(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function load() {
    setLoading(true);
    setMessage(null);

    let response: Response;
    try {
      response = await fetch("/api/capture-sources/available?includeUnavailable=true", { cache: "no-store" });
    } catch {
      setLoading(false);
      setMessage("Could not reach the coordinator.");
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { sources?: AvailableCaptureSource[]; error?: string };

    setLoading(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Could not load cameras.");
      return;
    }

    setSources(payload.sources ?? []);
    if ((payload.sources ?? []).length === 0) {
      setMessage("No cameras are configured yet. Add one from Shelf Cameras or a node's camera page.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const groups = new Map<string, AvailableCaptureSource[]>();
  for (const source of sources) {
    const label = groupLabel(source);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(source);
  }
  const orphanSelected = selected.length > 0 && !sources.some((source) => source.id === selected);

  return (
    <div className="grid gap-2">
      <p className="text-sm font-semibold text-stone-800">Camera</p>
      <div className="grid gap-1 rounded-md border border-stone-200 p-2" role="radiogroup" aria-label="Camera">
        <label
          data-testid="capture-source-option-none"
          className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-stone-50"
        >
          <input type="radio" name="captureSourceId" checked={selected === ""} onChange={() => setSelected("")} />
          No camera
        </label>
        {[...groups.entries()].map(([label, groupSources]) => (
          <div key={label} className="mt-1">
            <p className="px-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
            <div className="grid gap-1">
              {groupSources.map((source) => (
                <label
                  key={source.id}
                  data-testid={`capture-source-option-${source.id}`}
                  className={`flex items-center justify-between gap-2 rounded-md p-2 text-sm ${
                    source.selectable ? "hover:bg-stone-50" : "opacity-60"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="captureSourceId"
                      checked={selected === source.id}
                      disabled={!source.selectable}
                      onChange={() => setSelected(source.id)}
                    />
                    <span>
                      {source.logicalCameraName ?? source.name}
                      <span className="ml-1.5 text-xs text-stone-500">
                        {source.width}x{source.height}
                      </span>
                    </span>
                  </span>
                  {source.retired ? (
                    <span className="rounded-md bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600">Retired</span>
                  ) : !source.available ? (
                    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Unavailable</span>
                  ) : (
                    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">Available</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
        {orphanSelected ? (
          <p className="px-2 text-xs text-stone-500">
            The currently selected capture source is no longer listed (it may have been retired).
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="button-secondary" onClick={load} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh camera list"}
        </button>
        {message ? <span className="text-sm text-stone-600">{message}</span> : null}
      </div>
    </div>
  );
}
