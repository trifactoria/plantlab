"use client";

import { PointerEvent, useRef, useState } from "react";

export type CropValue = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

type Point = {
  x: number;
  y: number;
};

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function CropSelector({
  imageUrl,
  value,
  onChange,
}: {
  imageUrl: string;
  value: CropValue | null;
  onChange: (crop: CropValue | null) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [draft, setDraft] = useState<CropValue | null>(value);

  function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    if (!image) {
      return null;
    }

    const rect = image.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width);
    const y = clamp((event.clientY - rect.top) / rect.height);
    return { x, y };
  }

  function cropFromPoints(start: Point, end: Point): CropValue | null {
    const cropX = Math.min(start.x, end.x);
    const cropY = Math.min(start.y, end.y);
    const cropWidth = Math.abs(start.x - end.x);
    const cropHeight = Math.abs(start.y - end.y);

    if (cropWidth <= 0.005 || cropHeight <= 0.005) {
      return null;
    }

    return { cropX, cropY, cropWidth, cropHeight };
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    setDraft(null);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) {
      return;
    }

    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    setDraft(cropFromPoints(dragStart, point));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) {
      return;
    }

    const point = pointFromEvent(event);
    const crop = point ? cropFromPoints(dragStart, point) : null;
    setDragStart(null);
    setDraft(crop);
    onChange(crop);
  }

  const visibleCrop = draft ?? value;

  return (
    <div className="grid gap-3">
      <div className="grid max-h-[420px] min-h-[220px] place-items-center overflow-hidden rounded-md bg-black">
        <div
          className="relative w-full cursor-crosshair"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={imageUrl}
            alt="Crop source"
            className="max-h-[420px] w-full object-contain"
            draggable={false}
          />
          {visibleCrop ? (
            <div
              className="pointer-events-none absolute border-2 border-cyan-300 bg-cyan-300/20"
              style={{
                left: `${visibleCrop.cropX * 100}%`,
                top: `${visibleCrop.cropY * 100}%`,
                width: `${visibleCrop.cropWidth * 100}%`,
                height: `${visibleCrop.cropHeight * 100}%`,
              }}
            />
          ) : null}
        </div>
      </div>
      {visibleCrop ? (
        <div className="flex items-center gap-3">
          <div className="relative h-20 w-28 overflow-hidden rounded border border-stone-200 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="Crop preview"
              className="absolute max-w-none"
              style={{
                left: `${-(visibleCrop.cropX / visibleCrop.cropWidth) * 100}%`,
                top: `${-(visibleCrop.cropY / visibleCrop.cropHeight) * 100}%`,
                width: `${100 / visibleCrop.cropWidth}%`,
                height: `${100 / visibleCrop.cropHeight}%`,
              }}
            />
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setDraft(null);
              onChange(null);
            }}
          >
            Remove Crop
          </button>
        </div>
      ) : (
        <p className="text-sm text-stone-600">Drag on the image to select an optional crop.</p>
      )}
    </div>
  );
}
