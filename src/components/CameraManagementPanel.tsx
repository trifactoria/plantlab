"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { formatAge } from "@/lib/greenhouseDisplay";
import { ConfirmActionButton } from "./ConfirmActionButton";
import { CameraReattachDrawer } from "./CameraReattachDrawer";

export type CameraFormatMode = { pixelFormat?: string; resolutions?: Array<{ width: number; height: number }> };

export type ManagedCamera = {
  id: string;
  stableId: string;
  legacyStableId: string | null;
  name: string;
  devicePath: string;
  available: boolean;
  enabled: boolean;
  retiredAt: string | null;
  lastSeenAt: string;
  vendorId: string | null;
  productId: string | null;
  serial: string | null;
  physicalPath: string | null;
  usbPath: string | null;
  usbPort: string | null;
  identityEvidence: Record<string, unknown> | null;
  captureSourceId: string | null;
  formats: CameraFormatMode[];
  formatsCount: number;
  assignment: {
    id: string;
    name: string;
    width: number;
    height: number;
    inputFormat: string;
    active: boolean;
    captureSource: { id: string; name: string; rotation: number; flipHorizontal: boolean; flipVertical: boolean } | null;
    recentJob: { id: string; status: string; requestedAt: string; completedAt: string | null; errorMessage: string | null } | null;
  } | null;
  endpoints: Array<{ id: string; stableId: string; devicePath: string; available: boolean; observedAt: string; unavailableAt: string | null; confidence: string; evidence: Record<string, unknown> | null }>;
};

const POLL_INTERVAL_MS = 20_000;

export function CameraManagementPanel({ nodeName }: { nodeName: string }) {
  const [cameras, setCameras] = useState<ManagedCamera[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reattachFor, setReattachFor] = useState<ManagedCamera | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/nodes/${nodeName}/cameras`, { cache: "no-store" });
      if (response.status === 404) {
        setLoadError("Node not found.");
        return;
      }
      if (!response.ok) {
        setLoadError("Could not load cameras.");
        return;
      }
      const body = await response.json();
      setCameras(body.cameras);
      setLoadError(null);
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const runAction = useCallback(
    async (key: string, request: () => Promise<Response>) => {
      setBusy(key);
      setActionError(null);
      try {
        const response = await request();
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setActionError(body.error ?? "The action failed.");
          return false;
        }
        await load();
        return true;
      } catch {
        setActionError("Could not reach the coordinator.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  async function requestRefresh() {
    await runAction("refresh", () => fetch(`/api/nodes/${nodeName}/cameras/refresh-request`, { method: "POST" }));
  }

  if (loadError && !cameras) {
    return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>;
  }
  if (!cameras) {
    return <p className="text-sm text-stone-600">Loading cameras...</p>;
  }

  const retired = cameras.filter((camera) => camera.retiredAt);
  const live = cameras.filter((camera) => !camera.retiredAt);
  const active = live.filter((camera) => camera.available);
  const unavailable = live.filter((camera) => !camera.available);

  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-stone-600">
          Logical cameras keep a stable identity across USB reconnects. Cameras are matched by serial and physical/USB path evidence, not by device path, which can change on any replug.
        </p>
        <button type="button" className="button-secondary" disabled={busy !== null} onClick={requestRefresh}>
          {busy === "refresh" ? "Requesting..." : "Refresh inventory"}
        </button>
      </div>

      {actionError ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700" role="alert">{actionError}</p> : null}

      <CameraGroup title="Active cameras" hint="Available and assigned to a capture source." cameras={active} emptyLabel="No active cameras.">
        {(camera) => <CameraCard key={camera.id} nodeName={nodeName} camera={camera} busy={busy} runAction={runAction} onReattach={() => setReattachFor(camera)} />}
      </CameraGroup>

      {unavailable.length > 0 ? (
        <CameraGroup title="Unavailable cameras" hint="Configured but not seen in the latest inventory - often a USB path change. Reattach to a matching discovered endpoint." cameras={unavailable} tone="warning">
          {(camera) => <CameraCard key={camera.id} nodeName={nodeName} camera={camera} busy={busy} runAction={runAction} onReattach={() => setReattachFor(camera)} />}
        </CameraGroup>
      ) : null}

      {retired.length > 0 ? (
        <CameraGroup title="Retired cameras" hint="Kept for history - captures and identity evidence are preserved. Restore to bring one back." cameras={retired} tone="muted">
          {(camera) => <CameraCard key={camera.id} nodeName={nodeName} camera={camera} busy={busy} runAction={runAction} onReattach={() => setReattachFor(camera)} />}
        </CameraGroup>
      ) : null}

      {reattachFor ? (
        <CameraReattachDrawer
          nodeName={nodeName}
          camera={reattachFor}
          onClose={() => setReattachFor(null)}
          onDone={async () => {
            setReattachFor(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function CameraGroup({
  title,
  hint,
  cameras,
  children,
  emptyLabel,
  tone = "default",
}: {
  title: string;
  hint: string;
  cameras: ManagedCamera[];
  children: (camera: ManagedCamera) => React.ReactNode;
  emptyLabel?: string;
  tone?: "default" | "warning" | "muted";
}) {
  const titleTone = tone === "warning" ? "text-amber-800" : tone === "muted" ? "text-stone-500" : "text-stone-950";
  return (
    <section className="grid grid-cols-1 gap-3">
      <div>
        <h3 className={`text-sm font-semibold uppercase tracking-wide ${titleTone}`}>
          {title} ({cameras.length})
        </h3>
        <p className="text-xs text-stone-500">{hint}</p>
      </div>
      {cameras.length === 0 && emptyLabel ? <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">{emptyLabel}</p> : null}
      {cameras.map((camera) => children(camera))}
    </section>
  );
}

function CameraCard({
  nodeName,
  camera,
  busy,
  runAction,
  onReattach,
}: {
  nodeName: string;
  camera: ManagedCamera;
  busy: string | null;
  runAction: (key: string, request: () => Promise<Response>) => Promise<boolean>;
  onReattach: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(camera.name);
  const [configuring, setConfiguring] = useState(false);
  const retired = Boolean(camera.retiredAt);

  const statusTone = retired
    ? "border-stone-200 bg-stone-100 text-stone-600"
    : camera.available
      ? "border-emerald-200 bg-emerald-100 text-emerald-900"
      : "border-amber-200 bg-amber-100 text-amber-900";
  const statusLabel = retired ? "Retired" : camera.available ? "Available" : "Unavailable";

  return (
    <div data-testid={`camera-card-${camera.id}`} className={`rounded-lg border p-4 shadow-sm ${retired ? "border-stone-200 bg-stone-50" : "border-stone-200 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input className="input" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} aria-label="Camera name" />
              <button
                type="button"
                className="button"
                disabled={busy !== null || !nameDraft.trim()}
                onClick={async () => {
                  const ok = await runAction(`rename:${camera.id}`, () =>
                    fetch(`/api/nodes/${nodeName}/cameras/${camera.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: nameDraft.trim() }) }),
                  );
                  if (ok) setRenaming(false);
                }}
              >
                Save
              </button>
              <button type="button" className="button-secondary" onClick={() => { setRenaming(false); setNameDraft(camera.name); }}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-stone-950">{camera.name}</h4>
              {!camera.enabled && !retired ? <span className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">Disabled</span> : null}
            </div>
          )}
          <p className="mt-1 font-mono text-xs text-stone-400">Logical ID {camera.id}</p>
        </div>
        <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${statusTone}`}>{statusLabel}</span>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-stone-600 sm:grid-cols-2">
        <Evidence label="Current endpoint" value={camera.available ? camera.devicePath : `${camera.devicePath} (last seen)`} mono />
        <Evidence label="Stable ID" value={camera.stableId} mono />
        {camera.legacyStableId ? <Evidence label="Legacy stable ID" value={camera.legacyStableId} mono /> : null}
        <Evidence label="Vendor / product" value={camera.vendorId || camera.productId ? `${camera.vendorId ?? "?"}:${camera.productId ?? "?"}` : "unknown"} />
        <Evidence label="Serial" value={camera.serial ?? "none reported"} />
        <Evidence label="Physical path" value={camera.physicalPath ?? "unknown"} mono />
        <Evidence label="USB port / path" value={camera.usbPort ?? camera.usbPath ?? "unknown"} mono />
        <Evidence label="Advertised modes" value={camera.formatsCount > 0 ? String(camera.formatsCount) : "none reported"} />
        <Evidence label="Historical endpoints" value={String(camera.endpoints.length)} />
        <Evidence label="Last seen" value={`${formatAge(camera.lastSeenAt)} (${formatDateTime(camera.lastSeenAt)})`} />
      </dl>

      {camera.assignment ? (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-700">
          <p className="font-semibold text-stone-800">Capture assignment</p>
          <p className="mt-1">
            {camera.assignment.name} · {camera.assignment.width}x{camera.assignment.height} · {camera.assignment.inputFormat.toUpperCase()}
            {camera.assignment.captureSource ? ` · rotation ${camera.assignment.captureSource.rotation}°` : ""}
            {camera.assignment.active ? "" : " · (inactive)"}
          </p>
          {camera.assignment.recentJob ? (
            <p className={`mt-1 ${camera.assignment.recentJob.status === "failed" ? "text-red-700" : camera.assignment.recentJob.status === "completed" ? "text-emerald-700" : "text-amber-700"}`}>
              Recent capture: {camera.assignment.recentJob.status} ({formatAge(camera.assignment.recentJob.requestedAt)})
              {camera.assignment.recentJob.errorMessage ? ` - ${camera.assignment.recentJob.errorMessage}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-stone-500">No captures yet.</p>
          )}
          {camera.captureSourceId ? (
            <Link href={`/capture-sources/${camera.captureSourceId}`} className="mt-1 inline-block font-semibold text-emerald-700 hover:underline">
              Open capture source (rotation, viewports) &rarr;
            </Link>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-stone-500">Not attached to a capture source.</p>
      )}

      {configuring && camera.assignment ? (
        <AssignmentConfigForm
          nodeName={nodeName}
          camera={camera}
          busy={busy}
          runAction={runAction}
          onClose={() => setConfiguring(false)}
        />
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {!renaming ? (
          <button type="button" className="button-secondary" onClick={() => setRenaming(true)}>
            Rename
          </button>
        ) : null}
        {camera.assignment ? (
          <button type="button" className="button-secondary" onClick={() => setConfiguring((prev) => !prev)}>
            {configuring ? "Close config" : "Configure"}
          </button>
        ) : null}
        {camera.assignment ? (
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== null}
            onClick={() => runAction(`test:${camera.id}`, () => fetch(`/api/nodes/${nodeName}/camera-assignments/${camera.assignment!.id}/test-capture`, { method: "POST" }))}
          >
            {busy === `test:${camera.id}` ? "Queuing..." : "Test capture"}
          </button>
        ) : null}
        {!retired ? (
          camera.enabled ? (
            <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => runAction(`toggle:${camera.id}`, () => fetch(`/api/nodes/${nodeName}/cameras/${camera.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }))}>
              Disable
            </button>
          ) : (
            <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => runAction(`toggle:${camera.id}`, () => fetch(`/api/nodes/${nodeName}/cameras/${camera.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }))}>
              Enable
            </button>
          )
        ) : null}
        {!camera.available && !retired ? (
          <button type="button" className="button" onClick={onReattach}>
            Reattach
          </button>
        ) : null}
        {retired ? (
          <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => runAction(`restore:${camera.id}`, () => fetch(`/api/nodes/${nodeName}/cameras/${camera.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ retired: false }) }))}>
            Restore
          </button>
        ) : (
          <ConfirmActionButton
            title="Retire this camera?"
            message={`Retire ${camera.name}? Its captures and identity history are preserved and it stops appearing as active. You can restore it later. This does not delete anything.`}
            confirmLabel="Retire"
            onConfirm={() => runAction(`retire:${camera.id}`, () => fetch(`/api/nodes/${nodeName}/cameras/${camera.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ retired: true }) }))}
          >
            Retire
          </ConfirmActionButton>
        )}
      </div>
    </div>
  );
}

function AssignmentConfigForm({
  nodeName,
  camera,
  busy,
  runAction,
  onClose,
}: {
  nodeName: string;
  camera: ManagedCamera;
  busy: string | null;
  runAction: (key: string, request: () => Promise<Response>) => Promise<boolean>;
  onClose: () => void;
}) {
  const assignment = camera.assignment!;
  const [name, setName] = useState(assignment.name);
  const [width, setWidth] = useState(assignment.width);
  const [height, setHeight] = useState(assignment.height);
  const [inputFormat, setInputFormat] = useState(assignment.inputFormat);
  const [rotation, setRotation] = useState(assignment.captureSource?.rotation ?? 0);

  const modes = camera.formats.flatMap((format) => (format.resolutions ?? []).map((resolution) => ({ pixelFormat: (format.pixelFormat ?? "mjpeg").toLowerCase(), width: resolution.width, height: resolution.height })));

  async function save() {
    const ok = await runAction(`assignment:${assignment.id}`, () =>
      fetch(`/api/nodes/${nodeName}/camera-assignments/${assignment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), width, height, inputFormat }),
      }),
    );
    // Rotation lives on the capture source, not the assignment, so it is a
    // separate structured request against the capture-source route.
    if (ok && assignment.captureSource && rotation !== assignment.captureSource.rotation) {
      await runAction(`rotation:${assignment.id}`, () =>
        fetch(`/api/capture-sources/${assignment.captureSource!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rotation }) }),
      );
    }
    if (ok) onClose();
  }

  return (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-stone-300 bg-white p-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="field sm:col-span-2 lg:col-span-3">
        <span className="text-xs font-medium text-stone-700">Assignment name</span>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span className="text-xs font-medium text-stone-700">Resolution</span>
        <select
          className="input"
          value={`${inputFormat}:${width}x${height}`}
          onChange={(event) => {
            const [format, dims] = event.target.value.split(":");
            const [w, h] = dims.split("x").map(Number);
            setInputFormat(format);
            setWidth(w);
            setHeight(h);
          }}
        >
          <option value={`${inputFormat}:${width}x${height}`}>
            {inputFormat.toUpperCase()} {width}x{height} (current)
          </option>
          {modes
            .filter((mode) => !(mode.pixelFormat === inputFormat && mode.width === width && mode.height === height))
            .map((mode) => (
              <option key={`${mode.pixelFormat}:${mode.width}x${mode.height}`} value={`${mode.pixelFormat}:${mode.width}x${mode.height}`}>
                {mode.pixelFormat.toUpperCase()} {mode.width}x{mode.height}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span className="text-xs font-medium text-stone-700">Rotation</span>
        <select className="input" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} disabled={!assignment.captureSource}>
          {[0, 90, 180, 270].map((value) => (
            <option key={value} value={value}>
              {value}°
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-2">
        <button type="button" className="button" disabled={busy !== null} onClick={save}>
          Save config
        </button>
        <button type="button" className="button-secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-stone-500 sm:col-span-2 lg:col-span-3">
        Rotation is stored on the capture source. Changing resolution or rotation does not reconnect hardware - use Reattach for a camera that moved USB ports.
      </p>
    </div>
  );
}

function Evidence({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className={`text-right text-stone-800 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
