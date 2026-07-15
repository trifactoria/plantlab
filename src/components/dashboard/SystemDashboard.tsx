"use client";

import Link from "next/link";
import { SupportBundlePanel } from "@/components/SupportBundlePanel";
import { SummaryCard } from "@/components/shell/SummaryCard";

export type SystemInfo = {
  installationName: string;
  mode: string;
  hostname: string;
  attachedNodeCount: number;
  coordinator: boolean;
};

/**
 * System tab body: system information, coordinator maintenance links, and
 * support-bundle generation - the destinations that used to be loose header
 * links. Support bundle generation is embedded here (the same panel the
 * /support page uses) so diagnostics live inside the dashboard.
 */
export function SystemDashboard({ info, nodeNames }: { info: SystemInfo; nodeNames: string[] }) {
  return (
    <div className="grid gap-6">
      <SummaryCard title="System information">
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="font-medium text-stone-950">Installation</dt>
            <dd className="text-stone-600">{info.installationName}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Mode</dt>
            <dd className="text-stone-600">{info.mode}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Hostname</dt>
            <dd className="text-stone-600">{info.hostname}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Attached nodes</dt>
            <dd className="text-stone-600">{info.attachedNodeCount}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link href="/capture-sources" className="font-semibold text-emerald-700 hover:text-emerald-900">
            Shelf cameras &rarr;
          </Link>
          <Link href="/support" className="font-semibold text-emerald-700 hover:text-emerald-900">
            Support bundles page &rarr;
          </Link>
        </div>
      </SummaryCard>

      <div className="grid gap-3">
        <h2 className="text-lg font-semibold text-stone-950">Support bundles</h2>
        <p className="text-sm text-stone-600">
          Generate a redacted, read-only diagnostics archive for this installation and any attached nodes. One offline host yields a partial bundle
          rather than aborting the whole run.
        </p>
        <SupportBundlePanel nodeNames={nodeNames} />
      </div>
    </div>
  );
}
