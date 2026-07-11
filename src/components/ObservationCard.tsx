"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ObservationForm, ObservationFormEvent } from "@/components/ObservationForm";
import { StartingObservationMilestone } from "@/components/StartingObservationField";
import { isOriginEvent } from "@/lib/observationKinds";

/**
 * One reusable timeline entry, used on the plant page, project timeline, and
 * a photo's linked-events list. Every entry - including the plant's origin
 * event - exposes an Edit action that opens the shared ObservationForm.
 */
export function ObservationCard({
  event,
  plantId,
  milestones,
  timestampLabel,
  plantLink,
  photoHref,
}: {
  event: ObservationFormEvent;
  plantId: string;
  milestones: StartingObservationMilestone[];
  timestampLabel: string;
  plantLink?: { href: string; label: string };
  photoHref?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const isOrigin = isOriginEvent(event);

  return (
    <article
      className={`rounded-lg border p-5 shadow-sm ${
        isOrigin ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {plantLink ? (
            <Link href={plantLink.href} className="text-sm font-semibold text-emerald-700">
              {plantLink.label}
            </Link>
          ) : null}
          {isOrigin ? (
            <p className="text-xs font-semibold uppercase text-emerald-800">Starting entry</p>
          ) : null}
          <h3 className="mt-1 text-lg font-semibold text-stone-950">{event.type}</h3>
          <p className="text-sm text-stone-500">{timestampLabel}</p>
          {event.notes ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700">{event.notes}</p>
          ) : null}
        </div>

        <div className="grid gap-2 justify-items-start sm:justify-items-end">
          {photoHref ? (
            <Link className="button-secondary" href={photoHref}>
              Open Photo
            </Link>
          ) : null}
          <button type="button" className="button-secondary" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      </div>

      {event.photoId && event.cropX !== null ? (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/events/${event.id}/crop`}
            alt={`${event.type} crop`}
            className="max-h-28 max-w-full rounded-md border border-stone-200 bg-black object-contain"
          />
        </div>
      ) : null}

      {editing ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <ObservationForm
            plantId={plantId}
            milestones={milestones}
            event={event}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              router.refresh();
            }}
            onDeleted={() => {
              setEditing(false);
              router.refresh();
            }}
          />
        </div>
      ) : null}
    </article>
  );
}
