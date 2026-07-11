"use client";

import { ObservationMemory } from "@/lib/plantEntry";

export type StartingObservationMilestone = { id: string; label: string };

/**
 * Optional starting biological observation for a newly created plant. Picking
 * a project milestone links milestoneId on the resulting PlantEvent instead
 * of only duplicating its label into the event type.
 */
export function StartingObservationField({
  milestones,
  value,
  onChange,
  label = "Starting observation",
  helpText = "Optional. Records a normal event at the starting timestamp - leave blank to only add the plant.",
}: {
  milestones: StartingObservationMilestone[];
  value: ObservationMemory;
  onChange: (value: ObservationMemory) => void;
  label?: string;
  helpText?: string | null;
}) {
  const customValue = value.kind === "custom" ? value.label : "";

  return (
    <div className="field">
      <span>{label}</span>
      {helpText ? <p className="mb-1 text-xs font-normal text-stone-500">{helpText}</p> : null}
      {milestones.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {milestones.map((milestone) => {
            const selected = value.kind === "milestone" && value.milestoneId === milestone.id;
            return (
              <button
                key={milestone.id}
                type="button"
                className={
                  selected
                    ? "button-secondary border-emerald-400 bg-emerald-50 text-emerald-900"
                    : "button-secondary"
                }
                onClick={() =>
                  onChange(
                    selected
                      ? { kind: "none" }
                      : { kind: "milestone", milestoneId: milestone.id, label: milestone.label },
                  )
                }
              >
                {milestone.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <input
        className="input mt-2"
        placeholder="Or type a custom observation"
        value={customValue}
        onChange={(event) => {
          const label = event.target.value;
          onChange(label.trim() ? { kind: "custom", label } : { kind: "none" });
        }}
      />
    </div>
  );
}
