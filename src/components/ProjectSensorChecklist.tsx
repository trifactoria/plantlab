"use client";

import { useAvailableProjectSensors } from "./useAvailableProjectSensors";

/**
 * Project-creation "Environmental Sensors" checklist: applied/configured-
 * active sensors only, grouped by node, zero-or-more selection. Selected
 * sensor ids are linked via POST /api/projects/:id/sensors once the project
 * itself has been created - see ProjectForm.tsx.
 */
export function ProjectSensorChecklist({
  selected,
  onChange,
}: {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { sensors, loading, message } = useAvailableProjectSensors();

  function toggle(sensorId: string) {
    const next = new Set(selected);
    if (next.has(sensorId)) next.delete(sensorId);
    else next.add(sensorId);
    onChange(next);
  }

  const byNode = new Map<string, typeof sensors>();
  for (const sensor of sensors) {
    const label = sensor.node.name;
    if (!byNode.has(label)) byNode.set(label, []);
    byNode.get(label)!.push(sensor);
  }

  return (
    <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
      <p className="text-sm font-semibold text-stone-800">Environmental Sensors</p>
      {loading ? (
        <p className="text-sm text-stone-600">Loading sensors...</p>
      ) : message ? (
        <p className="text-sm text-stone-600">{message}</p>
      ) : null}
      {!loading && sensors.length > 0 ? (
        <div className="grid gap-2">
          {[...byNode.entries()].map(([nodeName, nodeSensors]) => (
            <div key={nodeName} className="grid gap-1">
              {byNode.size > 1 ? <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{nodeName}</p> : null}
              {nodeSensors.map((sensor) => (
                <label key={sensor.id} data-testid={`project-sensor-option-${sensor.id}`} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.has(sensor.id)} onChange={() => toggle(sensor.id)} />
                  {sensor.name}
                  {byNode.size === 1 ? <span className="text-xs text-stone-500">({sensor.node.name})</span> : null}
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
