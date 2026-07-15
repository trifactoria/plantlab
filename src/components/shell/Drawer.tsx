"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Generic slide-over drawer used for contextual create/edit flows (e.g. New
 * Project) so large forms don't sit permanently on a dashboard. On mobile it
 * fills the width; on larger screens it slides in from the right. Not tied to
 * any particular form - callers supply the title and body.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  widthClassName = "max-w-xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  widthClassName?: string;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-stone-950/40" role="dialog" aria-modal="true" aria-label={title}>
      {/* Backdrop click closes; the panel stops propagation. */}
      <button type="button" aria-label="Close" className="absolute inset-0 h-full w-full cursor-default" onClick={onClose} />
      <div className={`relative flex h-full w-full ${widthClassName} flex-col overflow-y-auto bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-stone-950">{title}</h2>
          <button
            type="button"
            className="rounded-md p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <span aria-hidden className="text-xl leading-none">&times;</span>
          </button>
        </div>
        <div className="grid gap-4 p-5">{children}</div>
      </div>
    </div>
  );
}
