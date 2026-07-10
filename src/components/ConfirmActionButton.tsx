"use client";

import { ReactNode, useState } from "react";

export function ConfirmActionButton({
  children,
  title,
  message,
  confirmLabel = "Confirm",
  disabled = false,
  onConfirm,
}: {
  children: ReactNode;
  title: string;
  message: string;
  confirmLabel?: string;
  disabled?: boolean;
  onConfirm: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const ok = await onConfirm();
    setBusy(false);

    if (ok) {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="button-secondary border-red-200 text-red-700 hover:bg-red-50"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        {children}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <div className="grid w-full max-w-md gap-4 rounded-lg bg-white p-5 shadow-xl">
            <div>
              <h2 className="text-lg font-semibold text-stone-950">{title}</h2>
              <p className="mt-2 text-sm text-stone-600">{message}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="button-secondary"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button-secondary border-red-200 text-red-700 hover:bg-red-50"
                onClick={confirm}
                disabled={busy}
              >
                {busy ? "Working..." : confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
