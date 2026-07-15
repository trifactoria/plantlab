"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { celsiusToFahrenheit, formatAge } from "@/lib/greenhouseDisplay";
import { SENSOR_TYPES, validateDraft, type DesiredEntry } from "@/lib/sensorManagement";
import { ConfirmActionButton } from "./ConfirmActionButton";

type ConfigSensor = {
  id: string;
  key: string;
  name: string;
  type: string;
  gpio: number | null;
  placement: string | null;
  enabled: boolean;
  configuredActive: boolean;
  retiredAt: string | null;
  desiredConfigRevision: number | null;
  appliedConfigRevision: number | null;
  latestClassification: string | null;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
};

type SensorConfigResponse = {
  node: {
    id: string;
    name: string;
    desiredRevision: number | null;
    appliedRevision: number | null;
    appliedStatus: string | null;
    appliedError: string | null;
    updatedAt: string | null;
  };
  desired: { revision: number; status: string; requestedAt: string; entries: DesiredEntry[]; rejectionReason: string | null } | null;
  sensors: ConfigSensor[];
  recentRevisions: Array<{ id: string; revision: number; applyStatus: string; requestedAt: string; appliedAt: string | null; rejectedAt: string | null; rejectionReason: string | null }>;
};

type ObservedSensor = {
  key: string;
  latestClassification: string | null;
  latestTemperatureC: number | null;
  latestHumidityPct: number | null;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  lastDiagnosticCode: string | null;
  lastDiagnosticMessage: string | null;
};

const EMPTY_DRAFT: DesiredEntry = { key: "", name: "", type: "dht22", gpio: 4, placement: "", enabled: true, retired: false };

const POLL_INTERVAL_MS = 15_000;

function toDraft(sensor: ConfigSensor): DesiredEntry {
  return {
    id: sensor.id,
    key: sensor.key,
    name: sensor.name,
    type: sensor.type,
    gpio: sensor.gpio ?? 0,
    placement: sensor.placement,
    enabled: sensor.enabled,
    retired: Boolean(sensor.retiredAt),
  };
}

function baselineDraft(config: SensorConfigResponse): DesiredEntry[] {
  if (config.desired) return config.desired.entries.map((entry) => ({ ...entry, placement: entry.placement ?? null, retired: Boolean(entry.retired) }));
  return config.sensors.map(toDraft);
}

/** Applied-status → operator-facing badge tone/label for the desired/applied header. */
const APPLY_STATUS: Record<string, { label: string; tone: string }> = {
  applied: { label: "Applied", tone: "border-emerald-200 bg-emerald-100 text-emerald-900" },
  pending: { label: "Waiting for node", tone: "border-amber-200 bg-amber-100 text-amber-900" },
  rejected: { label: "Rejected", tone: "border-red-200 bg-red-100 text-red-900" },
  unknown: { label: "Unknown", tone: "border-stone-200 bg-stone-100 text-stone-700" },
};

const OBSERVED_TONE: Record<string, string> = {
  accepted: "border-emerald-200 bg-emerald-100 text-emerald-900",
  stale: "border-amber-200 bg-amber-100 text-amber-900",
  rejected: "border-red-200 bg-red-100 text-red-900",
  suspect: "border-red-200 bg-red-100 text-red-900",
  failed: "border-red-200 bg-red-100 text-red-900",
  "driver-unavailable": "border-stone-200 bg-stone-100 text-stone-700",
};

export function SensorManagementPanel({ nodeName }: { nodeName: string }) {
  const [config, setConfig] = useState<SensorConfigResponse | null>(null);
  const [observed, setObserved] = useState<Record<string, ObservedSensor>>({});
  const [nodeStatus, setNodeStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<DesiredEntry[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<DesiredEntry>(EMPTY_DRAFT);
  const [addError, setAddError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<Record<string, string>>({});
  const baselineRef = useRef<string>("[]");

  const load = useCallback(async () => {
    try {
      const [configRes, envRes, nodeRes] = await Promise.all([
        fetch(`/api/nodes/${nodeName}/sensors/config`, { cache: "no-store" }),
        fetch(`/api/nodes/${nodeName}/environment`, { cache: "no-store" }),
        fetch(`/api/nodes/${nodeName}`, { cache: "no-store" }),
      ]);
      if (configRes.status === 404) {
        setLoadError("Node not found.");
        return;
      }
      if (!configRes.ok) {
        setLoadError("Could not load sensor configuration.");
        return;
      }
      const configBody = (await configRes.json()) as SensorConfigResponse;
      setConfig(configBody);
      setLoadError(null);

      const nextBaseline = JSON.stringify(baselineDraft(configBody));
      // Only reset the local draft when the server-side baseline actually
      // changed (a new revision landed) - otherwise a background poll would
      // discard the operator's unsaved edits mid-typing.
      if (nextBaseline !== baselineRef.current) {
        baselineRef.current = nextBaseline;
        setDraft(baselineDraft(configBody));
      }

      if (envRes.ok) {
        const envBody = await envRes.json();
        const map: Record<string, ObservedSensor> = {};
        for (const sensor of envBody.sensors as ObservedSensor[]) map[sensor.key] = sensor;
        setObserved(map);
      }
      if (nodeRes.ok) {
        const nodeBody = await nodeRes.json();
        setNodeStatus(nodeBody.node?.statusLabel ?? null);
      }
    } catch {
      setLoadError("Could not reach the coordinator.");
    }
  }, [nodeName]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const dirty = useMemo(() => draft !== null && JSON.stringify(draft) !== baselineRef.current, [draft]);
  const offline = nodeStatus === "offline";

  const validation = useMemo(
    () =>
      validateDraft(
        draft ?? [],
        (config?.sensors ?? []).map((sensor) => ({ key: sensor.key, gpio: sensor.gpio, appliedConfigRevision: sensor.appliedConfigRevision, lastAttemptAt: sensor.lastAttemptAt })),
      ),
    [draft, config],
  );

  function updateEntry(key: string, patch: Partial<DesiredEntry>) {
    setDraft((prev) => (prev ? prev.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)) : prev));
  }

  function resetDraft() {
    if (config) setDraft(baselineDraft(config));
  }

  function submitAdd() {
    setAddError(null);
    const key = addForm.key.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
      setAddError("Key must contain only letters, numbers, underscores, and hyphens.");
      return;
    }
    if ((draft ?? []).some((entry) => entry.key === key)) {
      setAddError(`A sensor with key "${key}" already exists.`);
      return;
    }
    if (!addForm.name.trim()) {
      setAddError("Display name is required.");
      return;
    }
    setDraft((prev) => [...(prev ?? []), { ...addForm, key, name: addForm.name.trim(), placement: addForm.placement?.trim() || null, retired: false }]);
    setAddForm(EMPTY_DRAFT);
    setShowAdd(false);
  }

  async function applyConfiguration() {
    if (!draft || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const response = await fetch(`/api/nodes/${nodeName}/sensors/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: draft.map((entry) => ({ ...entry, placement: entry.placement?.trim() || null })) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setApplyError(body.error ?? "Could not save desired configuration.");
        return;
      }
      baselineRef.current = "__forcing-reload__";
      await load();
    } catch {
      setApplyError("Could not reach the coordinator.");
    } finally {
      setApplying(false);
    }
  }

  async function runTest(sensorKey: string) {
    setTestMessage((prev) => ({ ...prev, [sensorKey]: "Starting..." }));
    try {
      const response = await fetch(`/api/nodes/${nodeName}/sensors/${sensorKey}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      setTestMessage((prev) => ({ ...prev, [sensorKey]: response.ok ? "Test queued - see the sensor detail page for results." : body.error ?? "Could not start test." }));
    } catch {
      setTestMessage((prev) => ({ ...prev, [sensorKey]: "Could not reach the coordinator." }));
    }
  }

  if (loadError && !config) {
    return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{loadError}</p>;
  }
  if (!config || !draft) {
    return <p className="text-sm text-stone-600">Loading sensor configuration...</p>;
  }

  const active = draft.filter((entry) => !entry.retired);
  const retired = draft.filter((entry) => entry.retired);

  return (
    <div className="grid grid-cols-1 gap-4">
      <ConfigStatusHeader config={config} dirty={dirty} />

      {applyError ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700" role="alert">{applyError}</p> : null}
      {validation.errors.length > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">Resolve before applying:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {validation.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {validation.warnings.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <ul className="list-disc space-y-0.5 pl-5">
            {validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="button" disabled={!dirty || applying || validation.errors.length > 0} onClick={applyConfiguration}>
          {applying ? "Saving desired revision..." : dirty ? "Apply desired configuration" : "No unsaved changes"}
        </button>
        {dirty ? (
          <button type="button" className="button-secondary" disabled={applying} onClick={resetDraft}>
            Discard changes
          </button>
        ) : null}
        <button type="button" className="button-secondary" onClick={() => setShowAdd((prev) => !prev)}>
          {showAdd ? "Cancel add" : "Add sensor"}
        </button>
        {offline ? <span className="text-xs font-medium text-amber-700">Node is offline - the desired revision will be saved and applied when it reconnects.</span> : null}
      </div>

      {showAdd ? <AddSensorForm form={addForm} onChange={setAddForm} onSubmit={submitAdd} error={addError} /> : null}

      <section className="grid grid-cols-1 gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Active sensors ({active.length})</h3>
        {active.length === 0 ? <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">No active sensors configured.</p> : null}
        {active.map((entry) => (
          <SensorRow
            key={entry.key}
            nodeName={nodeName}
            entry={entry}
            configSensor={config.sensors.find((sensor) => sensor.key === entry.key) ?? null}
            observed={observed[entry.key] ?? null}
            onUpdate={(patch) => updateEntry(entry.key, patch)}
            onTest={() => runTest(entry.key)}
            testMessage={testMessage[entry.key] ?? null}
          />
        ))}
      </section>

      {retired.length > 0 ? (
        <section className="grid grid-cols-1 gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Retired / historical sensors ({retired.length})</h3>
          {retired.map((entry) => (
            <SensorRow
              key={entry.key}
              nodeName={nodeName}
              entry={entry}
              configSensor={config.sensors.find((sensor) => sensor.key === entry.key) ?? null}
              observed={observed[entry.key] ?? null}
              onUpdate={(patch) => updateEntry(entry.key, patch)}
              onTest={() => runTest(entry.key)}
              testMessage={testMessage[entry.key] ?? null}
              retired
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ConfigStatusHeader({ config, dirty }: { config: SensorConfigResponse; dirty: boolean }) {
  const status = APPLY_STATUS[config.node.appliedStatus ?? "unknown"] ?? APPLY_STATUS.unknown;
  const drift =
    config.node.desiredRevision !== null &&
    config.node.appliedRevision !== null &&
    config.node.desiredRevision !== config.node.appliedRevision;
  const latest = config.recentRevisions[0] ?? null;
  const lastApplied = config.recentRevisions.find((revision) => revision.appliedAt);
  const lastRejected = config.recentRevisions.find((revision) => revision.rejectedAt);

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-950">Configuration status</h2>
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? <span className="rounded-md border border-sky-200 bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-900">Unsaved changes</span> : null}
          {drift ? <span className="rounded-md border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Desired/applied drift</span> : null}
          <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${status.tone}`}>{status.label}</span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Desired revision" value={config.node.desiredRevision !== null ? `#${config.node.desiredRevision}` : "none yet"} />
        <Field label="Applied revision" value={config.node.appliedRevision !== null ? `#${config.node.appliedRevision}` : "none yet"} />
        <Field label="Last requested" value={latest ? formatDateTime(latest.requestedAt) : "-"} />
        <Field label="Last applied" value={lastApplied?.appliedAt ? formatDateTime(lastApplied.appliedAt) : "-"} />
      </dl>
      {config.node.appliedStatus === "rejected" && config.node.appliedError ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">Last rejection {lastRejected?.rejectedAt ? `(${formatAge(lastRejected.rejectedAt)})` : ""}:</p>
          <p className="mt-1">{config.node.appliedError}</p>
          <p className="mt-1 text-xs text-red-700">The node is still running the last applied revision.</p>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-stone-500">
        <span className="font-medium text-stone-700">Desired</span> is your intended configuration. <span className="font-medium text-stone-700">Applied</span> is what the node
        accepted and is running. <span className="font-medium text-stone-700">Observed</span> hardware health is shown per sensor below and can differ from both.
      </p>
    </div>
  );
}

function SensorRow({
  nodeName,
  entry,
  configSensor,
  observed,
  onUpdate,
  onTest,
  testMessage,
  retired = false,
}: {
  nodeName: string;
  entry: DesiredEntry;
  configSensor: ConfigSensor | null;
  observed: ObservedSensor | null;
  onUpdate: (patch: Partial<DesiredEntry>) => void;
  onTest: () => void;
  testMessage: string | null;
  retired?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const observedClass = observed?.latestClassification ?? null;
  const hasReading = observed && observed.latestTemperatureC !== null && observed.latestHumidityPct !== null;
  const gpioChanged = configSensor && configSensor.gpio !== null && entry.gpio !== configSensor.gpio;
  const isApplied = configSensor && configSensor.appliedConfigRevision !== null && configSensor.appliedConfigRevision === configSensor.desiredConfigRevision;

  return (
    <div data-testid={`sensor-row-${entry.key}`} className={`rounded-lg border p-4 shadow-sm ${retired ? "border-stone-200 bg-stone-50" : "border-stone-200 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/nodes/${nodeName}/sensors/${entry.key}`} className="font-semibold text-emerald-700 hover:underline">
              {entry.name}
            </Link>
            <span className="text-xs text-stone-500">{entry.key}</span>
            {!entry.enabled && !retired ? <span className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">Disabled</span> : null}
            {retired ? <span className="rounded border border-stone-200 bg-stone-200 px-1.5 py-0.5 text-xs font-medium text-stone-700">Retired</span> : null}
          </div>
          <p className="mt-1 text-xs text-stone-500">
            {entry.type} · GPIO {entry.gpio}
            {entry.placement ? ` · ${entry.placement}` : ""}
            {configSensor ? ` · desired #${configSensor.desiredConfigRevision ?? "-"} / applied #${configSensor.appliedConfigRevision ?? "-"}` : ""}
            {isApplied ? "" : configSensor ? " · pending apply" : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {observedClass ? <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${OBSERVED_TONE[observedClass] ?? "border-stone-200 bg-stone-100 text-stone-700"}`}>Observed: {observedClass}</span> : <span className="text-xs text-stone-500">No observed reading</span>}
          {hasReading ? (
            <span className="text-xs text-stone-600">
              {celsiusToFahrenheit(observed!.latestTemperatureC!).toFixed(1)}&deg;F / {observed!.latestHumidityPct!.toFixed(0)}%
            </span>
          ) : null}
          {observed?.lastDiagnosticCode ? <span className="text-xs text-red-700">{observed.lastDiagnosticCode}</span> : null}
          <span className="text-xs text-stone-500">Last valid: {observed?.lastAcceptedAt ? formatAge(observed.lastAcceptedAt) : "never"}</span>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-stone-200 bg-stone-50 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="field">
            <span className="text-xs font-medium text-stone-700">Display name</span>
            <input className="input" value={entry.name} onChange={(event) => onUpdate({ name: event.target.value })} />
          </label>
          <label className="field">
            <span className="text-xs font-medium text-stone-700">Placement</span>
            <input className="input" value={entry.placement ?? ""} onChange={(event) => onUpdate({ placement: event.target.value })} />
          </label>
          <label className="field">
            <span className="text-xs font-medium text-stone-700">BCM GPIO</span>
            <input className="input" type="number" min={0} max={27} value={entry.gpio} onChange={(event) => onUpdate({ gpio: Number(event.target.value) })} />
          </label>
          <label className="field">
            <span className="text-xs font-medium text-stone-700">Type</span>
            <select className="input" value={entry.type} onChange={(event) => onUpdate({ type: event.target.value })}>
              {SENSOR_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          {gpioChanged ? (
            <p className="text-xs font-medium text-amber-700 sm:col-span-2 lg:col-span-4">
              Changing GPIO for a sensor with history keeps its past readings, but only apply this if the physical wiring actually moved.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="button-secondary" onClick={() => setEditing((prev) => !prev)}>
          {editing ? "Done editing" : "Edit"}
        </button>
        {!retired ? (
          entry.enabled ? (
            <button type="button" className="button-secondary" onClick={() => onUpdate({ enabled: false })}>
              Disable
            </button>
          ) : (
            <button type="button" className="button-secondary" onClick={() => onUpdate({ enabled: true })}>
              Enable
            </button>
          )
        ) : null}
        {retired ? (
          <button type="button" className="button-secondary" onClick={() => onUpdate({ retired: false, enabled: true })}>
            Restore
          </button>
        ) : (
          <ConfirmActionButton
            title="Retire this sensor?"
            message={`Retire ${entry.name} (${entry.key})? Its readings and diagnostic history are preserved, and it stops appearing in active charts. You can restore it later.`}
            confirmLabel="Retire"
            onConfirm={async () => {
              onUpdate({ retired: true, enabled: false });
              return true;
            }}
          >
            Retire
          </ConfirmActionButton>
        )}
        <button type="button" className="button-secondary" onClick={onTest}>
          Run test
        </button>
      </div>
      {testMessage ? <p className="mt-2 text-xs text-stone-600">{testMessage}</p> : null}
    </div>
  );
}

function AddSensorForm({ form, onChange, onSubmit, error }: { form: DesiredEntry; onChange: (form: DesiredEntry) => void; onSubmit: () => void; error: string | null }) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
      <h3 className="text-sm font-semibold text-stone-950">Add a sensor</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="field">
          <span className="text-xs font-medium text-stone-700">Logical key</span>
          <input className="input" value={form.key} placeholder="greenhouse-outside" onChange={(event) => onChange({ ...form, key: event.target.value })} />
        </label>
        <label className="field">
          <span className="text-xs font-medium text-stone-700">Display name</span>
          <input className="input" value={form.name} placeholder="Greenhouse Outside" onChange={(event) => onChange({ ...form, name: event.target.value })} />
        </label>
        <label className="field">
          <span className="text-xs font-medium text-stone-700">Type</span>
          <select className="input" value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value })}>
            {SENSOR_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="text-xs font-medium text-stone-700">BCM GPIO</span>
          <input className="input" type="number" min={0} max={27} value={form.gpio} onChange={(event) => onChange({ ...form, gpio: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span className="text-xs font-medium text-stone-700">Placement</span>
          <input className="input" value={form.placement ?? ""} placeholder="outside" onChange={(event) => onChange({ ...form, placement: event.target.value })} />
        </label>
      </div>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-3">
        <button type="button" className="button" onClick={onSubmit}>
          Add to draft
        </button>
        <span className="ml-2 text-xs text-stone-500">Added to the desired draft - apply below to save the revision.</span>
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
