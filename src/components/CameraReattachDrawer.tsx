"use client";

import { useEffect, useState } from "react";
import { formatAge } from "@/lib/greenhouseDisplay";
import type { ManagedCamera } from "./CameraManagementPanel";

type Candidate = {
  endpoint: {
    id: string;
    stableId: string;
    devicePath: string;
    name: string | null;
    vendorId: string | null;
    productId: string | null;
    serial: string | null;
    physicalPath: string | null;
    usbPath: string | null;
    usbPort: string | null;
    observedAt: string;
  };
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: string[];
};

const REASON_LABELS: Record<string, string> = {
  "already-linked-logical-camera": "Already this logical camera's own endpoint",
  "stable-id-match": "Same stable ID",
  "legacy-stable-id-match": "Matches a previous (legacy) stable ID",
  "vendor-product-serial-match": "Same vendor, product, and serial",
  "physical-path-match": "Same physical / USB path",
};

const CONFIDENCE_TONE: Record<string, string> = {
  high: "border-emerald-200 bg-emerald-100 text-emerald-900",
  medium: "border-amber-200 bg-amber-100 text-amber-900",
  low: "border-stone-200 bg-stone-100 text-stone-700",
};

export function CameraReattachDrawer({ nodeName, camera, onClose, onDone }: { nodeName: string; camera: ManagedCamera; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "submitting" | "done">("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/nodes/${nodeName}/cameras/${camera.id}/reattach`, { cache: "no-store" });
        if (cancelled) return;
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          setLoadError(body.error ?? "Could not load reattach candidates.");
          return;
        }
        const list = (body.candidates ?? []) as Candidate[];
        setCandidates(list);
        if (list.length === 1) setSelected(list[0].endpoint.id);
      } catch {
        if (!cancelled) setLoadError("Could not reach the coordinator.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeName, camera.id]);

  // The live cameras share identical vendor/product/serial, so a serial match
  // alone is not decisive. Flag ambiguity when more than one candidate scores
  // at medium+ confidence, or when several share only a serial match.
  const ambiguous =
    (candidates?.filter((candidate) => candidate.confidence !== "low").length ?? 0) > 1 ||
    (candidates?.filter((candidate) => candidate.reasons.includes("vendor-product-serial-match") && !candidate.reasons.includes("physical-path-match")).length ?? 0) > 1;

  async function submit(force: boolean) {
    if (!selected) return;
    setPhase("submitting");
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/nodes/${nodeName}/cameras/${camera.id}/reattach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpointId: selected, force }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Reattach failed.");
        if (typeof body.error === "string" && /already assigned to another active/i.test(body.error)) setNeedsForce(true);
        setPhase("idle");
        return;
      }
      setResult(`Reattached to ${body.camera?.devicePath ?? "the selected endpoint"} (${body.camera?.stableId ?? ""}).`);
      setPhase("done");
      await onDone();
    } catch {
      setError("Could not reach the coordinator.");
      setPhase("idle");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label={`Reattach ${camera.name}`}>
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-200 p-4">
          <h2 className="text-lg font-semibold text-stone-950">Reattach camera</h2>
          <button type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 p-4">
          <section className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
            <h3 className="font-semibold text-stone-800">Unavailable logical camera</h3>
            <p className="mt-1 text-stone-700">{camera.name}</p>
            <dl className="mt-2 grid grid-cols-1 gap-y-0.5 text-xs text-stone-600">
              <Row label="Stable ID" value={camera.stableId} />
              {camera.legacyStableId ? <Row label="Legacy stable ID" value={camera.legacyStableId} /> : null}
              <Row label="Last endpoint" value={camera.devicePath} />
              <Row label="Serial" value={camera.serial ?? "none"} />
              <Row label="Physical path" value={camera.physicalPath ?? "unknown"} />
              {camera.assignment ? <Row label="Assignment" value={`${camera.assignment.name} · ${camera.assignment.width}x${camera.assignment.height}`} /> : null}
            </dl>
          </section>

          {loadError ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</p> : null}

          {ambiguous ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Multiple endpoints could match this camera - the devices report identical serials, so confirm the USB / physical path before reattaching.
            </p>
          ) : null}

          {candidates && candidates.length === 0 ? (
            <p className="rounded-md border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">
              No available discovered endpoints to reattach to right now. Refresh inventory, or check the camera is physically connected.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-2">
            {(candidates ?? []).map((candidate) => (
              <label
                key={candidate.endpoint.id}
                className={`grid cursor-pointer gap-1 rounded-md border p-3 text-sm ${selected === candidate.endpoint.id ? "border-emerald-400 bg-emerald-50" : "border-stone-200 bg-white"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <input type="radio" name="reattach-candidate" checked={selected === candidate.endpoint.id} onChange={() => setSelected(candidate.endpoint.id)} />
                    <span className="font-mono text-sm text-stone-900">{candidate.endpoint.devicePath}</span>
                  </div>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${CONFIDENCE_TONE[candidate.confidence]}`}>{candidate.confidence} confidence</span>
                </div>
                <dl className="grid grid-cols-1 gap-y-0.5 pl-6 text-xs text-stone-600">
                  <Row label="Physical path" value={candidate.endpoint.physicalPath ?? "unknown"} />
                  <Row label="USB port / path" value={candidate.endpoint.usbPort ?? candidate.endpoint.usbPath ?? "unknown"} />
                  <Row label="Serial" value={candidate.endpoint.serial ?? "none"} />
                  <Row label="Observed" value={formatAge(candidate.endpoint.observedAt)} />
                </dl>
                <div className="flex flex-wrap gap-1 pl-6">
                  {candidate.reasons.length === 0 ? (
                    <span className="text-xs text-amber-700">Weak match - verify manually.</span>
                  ) : (
                    candidate.reasons.map((reason) => (
                      <span key={reason} className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 text-xs text-stone-700">
                        {REASON_LABELS[reason] ?? reason}
                      </span>
                    ))
                  )}
                </div>
              </label>
            ))}
          </div>

          {error ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p> : null}
          {result ? <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{result}</p> : null}

          {phase !== "done" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="button" disabled={!selected || phase === "submitting"} onClick={() => submit(false)}>
                {phase === "submitting" ? "Reattaching..." : "Reattach to selected endpoint"}
              </button>
              {needsForce ? (
                <button type="button" className="button-secondary" disabled={phase === "submitting"} onClick={() => submit(true)}>
                  Force reattach (endpoint is claimed by another camera)
                </button>
              ) : null}
            </div>
          ) : (
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-mono text-stone-800">{value}</dd>
    </div>
  );
}
