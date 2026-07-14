"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { formatAge } from "@/lib/greenhouseDisplay";
import { NodeTimelinePanel } from "./NodeTimelinePanel";

type NodeSummary = {
  node: {
    id: string;
    name: string;
    role: string;
    hostname: string | null;
    operatingSystem: string | null;
    architecture: string | null;
    runtime: string | null;
    softwareVersion: string | null;
    protocolVersion: string | null;
    coordinatorUrl: string | null;
    lastHeartbeatAt: string | null;
    lastInventoryAt: string | null;
    statusLabel: "pending" | "active" | "repair-required" | "revoked" | "offline";
    capabilities: string[];
  };
  cameras: { total: number; available: number; unavailable: number };
  sensors: { total: number; healthy: number; failed: number; stale: number; rejected: number };
  power: { total: number; on: number; off: number; unknown: number };
  queue: {
    capture: { queued: number; claimed: number };
    power: { pending: number; claimed: number };
    sensorTests: { pending: number; claimed: number; running: number };
  };
};

const STATUS_STYLES: Record<NodeSummary["node"]["statusLabel"], string> = {
  active: "bg-emerald-100 text-emerald-900 border-emerald-200",
  pending: "bg-stone-100 text-stone-700 border-stone-200",
  "repair-required": "bg-amber-100 text-amber-900 border-amber-200",
  offline: "bg-red-100 text-red-900 border-red-200",
  revoked: "bg-red-100 text-red-900 border-red-200",
};

const STATUS_LABEL: Record<NodeSummary["node"]["statusLabel"], string> = {
  active: "Online",
  pending: "Pending first heartbeat",
  "repair-required": "Repair required",
  offline: "Offline",
  revoked: "Revoked",
};

const POLL_INTERVAL_MS = 30_000;

export function NodeDetailPanel({ nodeName }: { nodeName: string }) {
  const [summary, setSummary] = useState<NodeSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const response = await fetch(`/api/nodes/${nodeName}`, { cache: "no-store" });
      if (!response.ok) {
        setLoadError("Could not load node status.");
        return;
      }
      setLoadError(null);
      setSummary(await response.json());
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName]);

  useEffect(() => {
    void loadSummary();
    const interval = window.setInterval(() => void loadSummary(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadSummary]);

  async function runAction(name: string, run: () => Promise<string>) {
    setActionBusy(name);
    setActionMessage(null);
    try {
      const message = await run();
      setActionMessage(message);
    } catch {
      setActionMessage("Action failed - could not reach the coordinator.");
    } finally {
      setActionBusy(null);
      await loadSummary();
    }
  }

  if (loadError && !summary) {
    return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>;
  }
  if (!summary) {
    return <p className="text-sm text-stone-600">Loading node status...</p>;
  }

  const { node, cameras, sensors, power, queue } = summary;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-stone-950">Identity and connectivity</h2>
          <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[node.statusLabel]}`}>{STATUS_LABEL[node.statusLabel]}</span>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Role" value={node.role} />
          <Field label="Hostname" value={node.hostname ?? "unknown"} />
          <Field label="Operating system" value={node.operatingSystem ?? "unknown"} />
          <Field label="Architecture" value={node.architecture ?? "unknown"} />
          <Field label="Runtime" value={node.runtime ?? "unknown"} />
          <Field label="Software version" value={node.softwareVersion ?? "unknown"} />
          <Field label="Protocol version" value={node.protocolVersion ?? "unknown"} />
          <Field label="Coordinator URL" value={node.coordinatorUrl ?? "not reported"} />
          <Field label="Last heartbeat" value={node.lastHeartbeatAt ? `${formatAge(node.lastHeartbeatAt)} (${formatDateTime(node.lastHeartbeatAt)})` : "never"} />
          <Field label="Last camera inventory" value={node.lastInventoryAt ? `${formatAge(node.lastInventoryAt)} (${formatDateTime(node.lastInventoryAt)})` : "never"} />
          <Field label="Capabilities" value={node.capabilities.length > 0 ? node.capabilities.join(", ") : "none reported"} />
        </dl>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SubsystemCard title="Cameras" ok={cameras.available} total={cameras.total} okLabel="available" href={`/nodes/${nodeName}/cameras`} />
        <SubsystemCard
          title="Sensors"
          ok={sensors.healthy}
          total={sensors.total}
          okLabel="healthy"
          degraded={sensors.stale + sensors.rejected}
          failed={sensors.failed}
          href={`/nodes/${nodeName}/sensors`}
        />
        <SubsystemCard title="Power outlets" ok={power.on + power.off} total={power.total} okLabel="reporting" failed={power.unknown} href={`/nodes/${nodeName}/power`} />
        <QueueCard title="Capture queue" queued={queue.capture.queued} claimed={queue.capture.claimed} />
        <QueueCard
          title="Power + test queue"
          queued={queue.power.pending + queue.sensorTests.pending}
          claimed={queue.power.claimed + queue.sensorTests.claimed + queue.sensorTests.running}
          href={`/nodes/${nodeName}/power`}
        />
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Actions</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="button-secondary" disabled={actionBusy !== null} onClick={() => runAction("refresh", async () => { await loadSummary(); return "Node status refreshed."; })}>
            {actionBusy === "refresh" ? "Refreshing..." : "Refresh node status"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={actionBusy !== null}
            onClick={() =>
              runAction("camera-refresh", async () => {
                const response = await fetch(`/api/nodes/${nodeName}/cameras/refresh-request`, { method: "POST" });
                return response.ok ? "Fresh camera inventory requested." : "Could not request camera inventory.";
              })
            }
          >
            {actionBusy === "camera-refresh" ? "Requesting..." : "Request fresh camera inventory"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={actionBusy !== null}
            onClick={() =>
              runAction("power-refresh", async () => {
                const response = await fetch(`/api/nodes/${nodeName}/power/refresh-request`, { method: "POST" });
                return response.ok ? "Power state refresh requested." : "Could not request power state refresh.";
              })
            }
          >
            {actionBusy === "power-refresh" ? "Requesting..." : "Refresh power state"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={actionBusy !== null}
            onClick={() =>
              runAction("diagnostics", async () => {
                const response = await fetch(`/api/nodes/${nodeName}/diagnostics`, { method: "POST" });
                if (!response.ok) return "Could not start node diagnostics.";
                const body = await response.json();
                const started = (body.results as Array<{ ok: boolean }>).filter((result) => result.ok).length;
                return `Diagnostics started for ${started} sensor(s). See sensor pages or the timeline for results.`;
              })
            }
          >
            {actionBusy === "diagnostics" ? "Starting..." : "Run node diagnostics"}
          </button>
        </div>
        {actionMessage ? <p className="mt-3 text-sm text-stone-600">{actionMessage}</p> : null}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-stone-950">Recent activity</h2>
          <Link href={`/nodes/${nodeName}/activity`} className="text-xs font-semibold text-emerald-700 hover:underline">
            View full activity &rarr;
          </Link>
        </div>
        <div className="mt-3">
          <NodeTimelinePanel nodeName={nodeName} />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-stone-950">{label}</dt>
      <dd className="text-stone-600">{value}</dd>
    </div>
  );
}

function SubsystemCard({
  title,
  ok,
  total,
  okLabel,
  degraded = 0,
  failed = 0,
  href,
}: {
  title: string;
  ok: number;
  total: number;
  okLabel: string;
  degraded?: number;
  failed?: number;
  href?: string;
}) {
  const content = (
    <>
      <h3 className="text-sm font-semibold text-stone-950">{title}</h3>
      <p className="mt-2 text-2xl font-semibold text-stone-950">
        {ok}
        <span className="text-sm font-normal text-stone-500"> / {total}</span>
      </p>
      <p className="text-xs text-stone-500">{okLabel}</p>
      {degraded > 0 ? <p className="mt-1 text-xs font-medium text-amber-700">{degraded} degraded</p> : null}
      {failed > 0 ? <p className="mt-1 text-xs font-medium text-red-700">{failed} failed</p> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="block rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-300">
        {content}
      </Link>
    );
  }
  return <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">{content}</div>;
}

function QueueCard({ title, queued, claimed, href }: { title: string; queued: number; claimed: number; href?: string }) {
  const content = (
    <>
      <h3 className="text-sm font-semibold text-stone-950">{title}</h3>
      <p className="mt-2 text-2xl font-semibold text-stone-950">{queued + claimed}</p>
      <p className="text-xs text-stone-500">
        {queued} queued, {claimed} in progress
      </p>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="block rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-300">
        {content}
      </Link>
    );
  }
  return <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">{content}</div>;
}
