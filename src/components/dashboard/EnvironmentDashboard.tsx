"use client";

import { EmptyState } from "@/components/shell/SummaryCard";
import { EnvironmentNodePanel } from "./EnvironmentNodePanel";

export type EnvironmentDashboardNode = { name: string; hasOutlets: boolean };

/**
 * Environment tab body: one panel per node that has environmental sensors. In
 * standalone mode with no sensors this is a single empty state; in coordinator
 * mode it lists each sensor-bearing node. Same component either way.
 */
export function EnvironmentDashboard({ nodes }: { nodes: EnvironmentDashboardNode[] }) {
  if (nodes.length === 0) {
    return (
      <EmptyState message="No environmental sensors are configured yet. Sensors attached to this installation or an attached node appear here with live readings and history." />
    );
  }
  return (
    <div className="grid gap-8">
      {nodes.map((node) => (
        <EnvironmentNodePanel key={node.name} nodeName={node.name} hasOutlets={node.hasOutlets} />
      ))}
    </div>
  );
}
