import Link from "next/link";

/**
 * A clickable resource count (e.g. cameras or sensors on a node) that links to
 * its configuration page. The primary number is always shown; a secondary
 * "N need attention" hint appears when some of the counted resources are
 * unavailable/degraded. Backend supplies the destination URL so the UI never
 * reconstructs route strings.
 */
export function ResourceCountLink({
  href,
  count,
  attention = 0,
  noun,
}: {
  href: string;
  count: number;
  attention?: number;
  noun: string;
}) {
  return (
    <Link href={href} className="group inline-flex items-baseline gap-1.5 hover:underline" data-testid="resource-count-link">
      <span className="font-semibold text-stone-950">{count}</span>
      <span className="text-stone-500 group-hover:text-stone-700">{noun}</span>
      {attention > 0 ? (
        <span className="rounded border border-amber-200 bg-amber-50 px-1 text-xs font-semibold text-amber-800">{attention}!</span>
      ) : null}
    </Link>
  );
}
