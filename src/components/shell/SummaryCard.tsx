import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Generic dashboard card: title, optional status/action in the header, and
 * arbitrary body content. Used for section panels and empty states so cards
 * across the dashboard share the same frame instead of ad hoc bordered divs.
 */
export function SummaryCard({
  title,
  headerRight,
  children,
  className = "",
}: {
  title?: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-stone-200 bg-white p-5 shadow-sm ${className}`}>
      {title != null || headerRight != null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title != null ? <h3 className="text-lg font-semibold text-stone-950">{title}</h3> : <span />}
          {headerRight}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Empty-state card with a message and an optional primary action. Replaces the
 * scattered dashed-border "nothing configured yet" blocks.
 */
export function EmptyState({ message, action }: { message: ReactNode; action?: { label: string; href?: string; onClick?: () => void } }) {
  return (
    <div className="grid gap-3 rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
      <p>{message}</p>
      {action ? (
        action.href ? (
          <Link href={action.href} className="button w-fit">
            {action.label}
          </Link>
        ) : (
          <button type="button" className="button w-fit" onClick={action.onClick}>
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}
