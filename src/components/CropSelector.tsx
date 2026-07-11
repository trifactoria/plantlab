"use client";

import { PointerEvent, useEffect, useRef, useState } from "react";
import { calculatePreviewCanvasSize } from "@/lib/cropGeometry";

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
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [draft, setDraft] = useState<CropValue | null>(value);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [previewSize, setPreviewSize] = useState({ width: 160, height: 120 });

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

  useEffect(() => {
    const img = imageRef.current;
    const canvas = previewCanvasRef.current;
    if (!img || !canvas || !visibleCrop || !img.naturalWidth || !img.naturalHeight) {
      return;
    }

    const nextPreviewSize = calculatePreviewCanvasSize(visibleCrop, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
    setPreviewSize(nextPreviewSize);
    canvas.width = nextPreviewSize.width;
    canvas.height = nextPreviewSize.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, nextPreviewSize.width, nextPreviewSize.height);
    ctx.drawImage(
      img,
      visibleCrop.cropX * img.naturalWidth,
      visibleCrop.cropY * img.naturalHeight,
      visibleCrop.cropWidth * img.naturalWidth,
      visibleCrop.cropHeight * img.naturalHeight,
      0,
      0,
      nextPreviewSize.width,
      nextPreviewSize.height,
    );
  }, [visibleCrop, imageUrl, naturalSize]);

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
            onLoad={(event) => {
              const img = event.currentTarget;
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }}
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
          <canvas
            ref={previewCanvasRef}
            width={previewSize.width}
            height={previewSize.height}
            className="max-h-48 rounded border border-stone-200 bg-black"
          />
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
