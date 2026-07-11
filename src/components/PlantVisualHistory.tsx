"use client";

import Link from "next/link";
import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EventActions } from "@/components/EventActions";
import { buildCropThumbnailUrl } from "@/lib/cropThumbnail";
import { formatDateTime, toDateTimeLocal } from "@/lib/format";

export type FrameIndexEntry = {
  photoId: string;
  timestamp: string;
};

type FrameEvent = {
  id: string;
  type: string;
  notes: string | null;
  timestamp: string;
  photoId: string | null;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
};

type FrameDetail = {
  photo: { id: string; timestamp: string; notes: string | null };
  crop: { id: string; updatedAt: string };
  events: FrameEvent[];
};

const SPEEDS = [0.5, 1, 2, 4] as const;
const BASE_STEP_MS = 500;
const EVENT_TYPES = ["Germinated", "Cotyledons", "First True Leaf", "Harvest Ready", "Harvested"];

function findClosestIndexByTime(frames: FrameIndexEntry[], targetMs: number) {
  let low = 0;
  let high = frames.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const midMs = new Date(frames[mid].timestamp).getTime();
    if (midMs < targetMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (low > 0) {
    const prevMs = new Date(frames[low - 1].timestamp).getTime();
    const currentMs = new Date(frames[low].timestamp).getTime();
    if (Math.abs(prevMs - targetMs) <= Math.abs(currentMs - targetMs)) {
      return low - 1;
    }
  }

  return low;
}

export function PlantVisualHistory({
  plantId,
  projectId,
  latestPhotoId,
  initialFrames,
  initialTotalCount,
  initialHasMore,
}: {
  plantId: string;
  projectId: string;
  latestPhotoId: string | null;
  initialFrames: FrameIndexEntry[];
  initialTotalCount: number;
  initialHasMore: boolean;
}) {
  const router = useRouter();
  const trackRef = useRef<HTMLDivElement>(null);
  const fetchedFrameIds = useRef(new Set<string>());
  const draggingRef = useRef(false);

  const [frames, setFrames] = useState(initialFrames);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [detailCache, setDetailCache] = useState<Map<string, FrameDetail>>(new Map());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [addingEvent, setAddingEvent] = useState(false);
  const [savingEvent, setSavingEvent] = useState(false);
  const [addEventError, setAddEventError] = useState<string | null>(null);
  const [reuseCrop, setReuseCrop] = useState(true);

  const currentFrame = frames[currentIndex] ?? null;
  const detail = currentFrame ? (detailCache.get(currentFrame.photoId) ?? null) : null;
  const firstMs = frames.length > 0 ? new Date(frames[0].timestamp).getTime() : 0;
  const lastMs = frames.length > 0 ? new Date(frames[frames.length - 1].timestamp).getTime() : 0;

  function fractionForFrame(frame: FrameIndexEntry) {
    if (lastMs === firstMs) {
      return 0;
    }
    return (new Date(frame.timestamp).getTime() - firstMs) / (lastMs - firstMs);
  }

  async function loadMoreIfNeeded(nextIndex: number) {
    if (!hasMore || loadingMore) {
      return;
    }
    if (nextIndex < frames.length - 20) {
      return;
    }

    setLoadingMore(true);
    const response = await fetch(
      `/api/plants/${plantId}/visual-history?offset=${frames.length}&limit=200`,
    );
    setLoadingMore(false);

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as {
      frames: FrameIndexEntry[];
      totalCount: number;
      hasMore: boolean;
    };

    setFrames((current) => [...current, ...payload.frames]);
    setTotalCount(payload.totalCount);
    setHasMore(payload.hasMore);
  }

  async function loadFrameDetail(photoId: string) {
    if (fetchedFrameIds.current.has(photoId)) {
      return;
    }
    fetchedFrameIds.current.add(photoId);

    const response = await fetch(`/api/plants/${plantId}/visual-history/frame?photoId=${photoId}`);
    if (!response.ok) {
      fetchedFrameIds.current.delete(photoId);
      return;
    }

    const payload = (await response.json()) as FrameDetail;
    setDetailCache((current) => {
      const next = new Map(current);
      next.set(photoId, payload);
      return next;
    });
  }

  useEffect(() => {
    if (!currentFrame) {
      return;
    }

    void loadFrameDetail(currentFrame.photoId);
    const previous = frames[currentIndex - 1];
    const next = frames[currentIndex + 1];
    if (previous) {
      void loadFrameDetail(previous.photoId);
    }
    if (next) {
      void loadFrameDetail(next.photoId);
    }
    void loadMoreIfNeeded(currentIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, frames.length]);

  useEffect(() => {
    if (!playing) {
      return;
    }

    const interval = window.setInterval(() => {
      setCurrentIndex((current) => {
        if (current >= frames.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, BASE_STEP_MS / speed);

    return () => window.clearInterval(interval);
  }, [playing, speed, frames.length]);

  function goTo(index: number) {
    setCurrentIndex(Math.max(0, Math.min(frames.length - 1, index)));
  }

  function positionFromClientX(clientX: number) {
    const track = trackRef.current;
    if (!track || frames.length === 0) {
      return null;
    }

    const rect = track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const targetMs = firstMs + fraction * (lastMs - firstMs);
    return findClosestIndexByTime(frames, targetMs);
  }

  function handleTrackPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setPlaying(false);
    const index = positionFromClientX(event.clientX);
    if (index !== null) {
      goTo(index);
    }
  }

  function handleTrackPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) {
      return;
    }
    const index = positionFromClientX(event.clientX);
    if (index !== null) {
      goTo(index);
    }
  }

  function handleTrackPointerUp() {
    draggingRef.current = false;
  }

  async function submitAddEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!currentFrame) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    setSavingEvent(true);
    setAddEventError(null);

    const crop =
      reuseCrop && detail
        ? await fetch(`/api/plant-photo-crops?plantId=${plantId}&photoId=${currentFrame.photoId}`)
            .then((response) => (response.ok ? response.json() : { crop: null }))
            .then((payload: { crop: { cropX: number; cropY: number; cropWidth: number; cropHeight: number } | null }) => payload.crop)
        : null;

    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plantId,
        photoId: currentFrame.photoId,
        type: formData.get("type"),
        notes: formData.get("notes"),
        timestamp: new Date(String(formData.get("timestamp"))).toISOString(),
        ...(crop ?? {}),
      }),
    });
    const payload = (await response.json()) as { error?: string };
    setSavingEvent(false);

    if (!response.ok) {
      setAddEventError(payload.error ?? "Could not add event.");
      return;
    }

    setAddingEvent(false);
    fetchedFrameIds.current.delete(currentFrame.photoId);
    await loadFrameDetail(currentFrame.photoId);
    router.refresh();
  }

  if (frames.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-center">
        <p className="text-lg font-semibold text-stone-950">No visual history yet.</p>
        <p className="mt-2 text-sm text-stone-600">
          Save a crop for this plant on any project photo to start building its visual history. One
          saved crop can be propagated to later photos when the camera and tray stay fixed, so you
          don&apos;t need to draw a new crop on every photo.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href={`/projects/${projectId}`} className="button-secondary">
            Choose a Project Photo
          </Link>
          {latestPhotoId ? (
            <Link href={`/photos/${latestPhotoId}`} className="button-secondary">
              Open Latest Photo
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div className="grid gap-3">
          <div className="relative aspect-square overflow-hidden rounded-lg border border-stone-200 bg-black shadow-sm">
            {currentFrame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={buildCropThumbnailUrl(
                  detail ? { id: detail.crop.id, updatedAt: detail.crop.updatedAt } : { id: currentFrame.photoId, updatedAt: currentFrame.timestamp },
                  { size: 640 },
                )}
                alt="Plant crop"
                className="h-full w-full object-contain"
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-stone-600">
            <span>
              Frame {currentIndex + 1} of {totalCount}
            </span>
            {currentFrame ? <span>{formatDateTime(currentFrame.timestamp)}</span> : null}
            {currentFrame ? (
              <Link href={`/photos/${currentFrame.photoId}`} className="font-semibold text-emerald-700">
                Open Full Photo
              </Link>
            ) : null}
          </div>

          {detail?.photo.notes ? (
            <p className="whitespace-pre-wrap rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
              {detail.photo.notes}
            </p>
          ) : null}
        </div>

        <div className="grid gap-3">
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-stone-950">Events on this frame</h3>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setAddEventError(null);
                  setAddingEvent(true);
                }}
              >
                Add Event
              </button>
            </div>
            <div className="mt-2 grid gap-2">
              {detail && detail.events.length > 0 ? (
                detail.events.map((event) => (
                  <div key={event.id} className="rounded-md border border-stone-200 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-stone-950">{event.type}</p>
                        <p className="text-xs text-stone-500">{formatDateTime(event.timestamp)}</p>
                      </div>
                      <EventActions event={event} />
                    </div>
                    {event.notes ? <p className="mt-2 text-sm text-stone-700">{event.notes}</p> : null}
                  </div>
                ))
              ) : (
                <p className="text-sm text-stone-500">No events recorded on this frame.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-2 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="button-secondary" onClick={() => goTo(currentIndex - 1)} disabled={currentIndex === 0}>
            Previous
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => goTo(currentIndex + 1)}
            disabled={currentIndex >= frames.length - 1 && !hasMore}
          >
            Next
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setPlaying((value) => !value)}
            disabled={currentIndex >= frames.length - 1 && !playing}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            Speed
            <select
              className="input w-auto"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value) as (typeof SPEEDS)[number])}
            >
              {SPEEDS.map((value) => (
                <option key={value} value={value}>
                  {value}x
                </option>
              ))}
            </select>
          </label>
          {loadingMore ? <span className="text-xs text-stone-400">Loading more frames...</span> : null}
        </div>

        <div
          ref={trackRef}
          data-testid="visual-history-track"
          className="relative h-8 cursor-pointer rounded-full bg-stone-100"
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          onPointerCancel={handleTrackPointerUp}
        >
          {frames.length <= 400
            ? frames.map((frame) => (
                <div
                  key={frame.photoId}
                  className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 bg-stone-300"
                  style={{ left: `${fractionForFrame(frame) * 100}%` }}
                />
              ))
            : null}
          <div
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-600 bg-white shadow"
            style={{ left: `${(currentFrame ? fractionForFrame(currentFrame) : 0) * 100}%` }}
          />
        </div>
        <p className="text-xs text-stone-400">
          Positioned by real capture time - gaps between captures show as wider spacing, not evenly
          divided frames.
        </p>
      </div>

      {addingEvent ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <form
            onSubmit={submitAddEvent}
            className="grid max-h-[90vh] w-full max-w-md gap-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
          >
            <h2 className="text-lg font-semibold text-stone-950">Add Event</h2>
            <label className="field">
              Event type
              <input className="input" name="type" list="visual-history-event-types" defaultValue="Germinated" required />
              <datalist id="visual-history-event-types">
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </label>
            <label className="field">
              Notes
              <textarea className="input min-h-24" name="notes" />
            </label>
            <label className="field">
              Timestamp
              <input
                className="input"
                name="timestamp"
                type="datetime-local"
                defaultValue={currentFrame ? toDateTimeLocal(currentFrame.timestamp) : undefined}
                required
              />
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
              <input type="checkbox" checked={reuseCrop} onChange={(event) => setReuseCrop(event.target.checked)} />
              Use this frame&apos;s saved plant crop as the event crop
            </label>
            {addEventError ? <p className="text-sm font-medium text-red-700">{addEventError}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setAddingEvent(false)}>
                Cancel
              </button>
              <button className="button" disabled={savingEvent}>
                {savingEvent ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
