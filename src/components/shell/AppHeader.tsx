import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The single PlantLab application header. Deliberately minimal: the product
 * name is the home link and everything else lives inside the dashboard tabs
 * (Support under System, camera management under Cameras, and so on) rather
 * than as loose top-level navigation links. Reusable across pages; pass
 * `breadcrumb`/`actions` for non-home surfaces later.
 */
export function AppHeader({ breadcrumb, actions }: { breadcrumb?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="container flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <Link href="/" className="text-xl font-semibold text-stone-950 hover:text-emerald-800">
            PlantLab <span className="text-sm font-medium text-stone-400">v0.1</span>
          </Link>
          {breadcrumb ? <div className="text-sm text-stone-500">{breadcrumb}</div> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
