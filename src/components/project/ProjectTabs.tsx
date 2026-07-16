import Link from "next/link";

export const PROJECT_TABS = [
  { id: "overview", label: "Overview" },
  { id: "photos", label: "Photos" },
  { id: "camera", label: "Camera" },
  { id: "environment", label: "Environment" },
  { id: "settings", label: "Settings" },
] as const;

export type ProjectTabId = (typeof PROJECT_TABS)[number]["id"];

export function normalizeProjectTab(value: string | string[] | undefined): ProjectTabId {
  const raw = Array.isArray(value) ? value[0] : value;
  return PROJECT_TABS.some((tab) => tab.id === raw) ? (raw as ProjectTabId) : "overview";
}

/**
 * Project workspace tab bar. Tabs are URL query parameters
 * (/projects/:id?tab=camera) so refresh and Back/Forward preserve the active
 * tab without exploding the route tree. Shares the dashboard tab visual
 * language so project pages feel like the same application.
 */
export function ProjectTabs({ projectId, active }: { projectId: string; active: ProjectTabId }) {
  return (
    <div className="overflow-x-auto border-b border-stone-200" role="tablist" aria-label="Project sections">
      <div className="flex min-w-max gap-1">
        {PROJECT_TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={`/projects/${projectId}?tab=${tab.id}`}
              role="tab"
              aria-selected={isActive}
              data-testid={`project-tab-${tab.id}`}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
                isActive
                  ? "border-emerald-600 text-emerald-800"
                  : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
