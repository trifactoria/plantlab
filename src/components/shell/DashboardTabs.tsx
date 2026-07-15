"use client";

import type { ReactNode } from "react";

export type DashboardTab = {
  id: string;
  label: string;
  /** Optional small count/indicator rendered after the label. */
  badge?: ReactNode;
};

/**
 * Reusable dashboard tab bar. Controlled by the parent so the active tab can
 * be persisted (state or URL) and shared by several dashboard surfaces. The
 * bar scrolls horizontally on small screens rather than wrapping, keeping the
 * mobile layout in a single row of large tap targets.
 */
export function DashboardTabs({
  tabs,
  activeId,
  onChange,
  label = "Dashboard sections",
}: {
  tabs: DashboardTab[];
  activeId: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <div className="overflow-x-auto border-b border-stone-200" role="tablist" aria-label={label}>
      <div className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`dashboard-panel-${tab.id}`}
              id={`dashboard-tab-${tab.id}`}
              data-testid={`dashboard-tab-${tab.id}`}
              onClick={() => onChange(tab.id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
                active
                  ? "border-emerald-600 text-emerald-800"
                  : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800"
              }`}
            >
              {tab.label}
              {tab.badge != null ? <span className="ml-1.5 align-middle">{tab.badge}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Renders its children only when `active`, wired to the matching tab for a11y. */
export function DashboardTabPanel({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`dashboard-panel-${id}`} aria-labelledby={`dashboard-tab-${id}`} className="pt-6">
      {children}
    </div>
  );
}
