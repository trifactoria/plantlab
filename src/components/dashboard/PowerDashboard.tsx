"use client";

import Link from "next/link";
import { PowerControlPanel } from "@/components/PowerControlPanel";
import { EmptyState } from "@/components/shell/SummaryCard";

/**
 * Power tab body: outlet controls, timers, and schedules for each node that
 * has power outlets, reusing the existing PowerControlPanel. Power history is
 * overlaid on the Environment charts; this tab owns the live controls.
 */
export function PowerDashboard({ nodeNames }: { nodeNames: string[] }) {
  if (nodeNames.length === 0) {
    return <EmptyState message="No power outlets are configured yet. Attach a node with a Kasa power strip (e.g. a greenhouse node) to control fans, lights, and other outlets from here." />;
  }
  return (
    <div className="grid gap-8">
      {nodeNames.map((nodeName) => (
        <div key={nodeName} className="grid gap-3">
          <h2 className="text-lg font-semibold text-stone-950">
            <Link href={`/nodes/${encodeURIComponent(nodeName)}/power`} className="hover:underline">
              {nodeName}
            </Link>
          </h2>
          <PowerControlPanel nodeName={nodeName} />
        </div>
      ))}
    </div>
  );
}
