"use client";

import { MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";

type Inspection = {
  xFraction: number;
  yFraction: number;
  panelX: number;
  panelY: number;
  sharpness: number | null;
};

type Rect = { x: number; y: number; width: number; height: number };

/** Where an object-fit: contain image actually renders within its box. */
function containRect(containerWidth: number, containerHeight: number, naturalWidth: number, naturalHeight: number): Rect {
  const containerRatio = containerWidth / containerHeight;
  const imageRatio = naturalWidth / naturalHeight;

  if (imageRatio > containerRatio) {
    const width = containerWidth;
    const height = width / imageRatio;
    return { x: 0, y: (containerHeight - height) / 2, width, height };
  }

  const height = containerHeight;
  const width = height * imageRatio;
  return { x: (containerWidth - width) / 2, y: 0, width, height };
}

/**
 * A crude, purely relative edge-strength score (average horizontal
 * grayscale gradient magnitude). Not a scientific sharpness measurement -
 * only meant to help compare "more" vs "less" detail between two clicks.
 */
function computeRelativeSharpness(imageData: ImageData): number {
  const { data, width, height } = imageData;
  let total = 0;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      const j = i + 4;
      const gray1 = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const gray2 = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      total += Math.abs(gray1 - gray2);
      count += 1;
    }
  }

  return count > 0 ? total / count : 0;
}

export function FocusInspector({
  imageUrl,
  alt = "Camera preview",
}: {
  imageUrl: string | null;
  alt?: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  function drawInspection(xFraction: number, yFraction: number) {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.naturalWidth || !img.naturalHeight) {
      return null;
    }

    const cropWidth = Math.max(24, Math.min(img.naturalWidth, img.naturalWidth * 0.12));
    const cropHeight = Math.max(24, Math.min(img.naturalHeight, img.naturalHeight * 0.12));
    const centerX = xFraction * img.naturalWidth;
    const centerY = yFraction * img.naturalHeight;
    const sx = Math.min(Math.max(0, centerX - cropWidth / 2), img.naturalWidth - cropWidth);
    const sy = Math.min(Math.max(0, centerY - cropHeight / 2), img.naturalHeight - cropHeight);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);

    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return computeRelativeSharpness(data);
    } catch {
      // Canvas may be tainted (cross-origin image) - inspection still shows
      // the magnified crop, just without a sharpness score.
      return null;
    }
  }

  function handleImageClick(event: ReactMouseEvent<HTMLImageElement>) {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return;
    }

    const rect = img.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const fitted = containRect(rect.width, rect.height, img.naturalWidth, img.naturalHeight);

    const withinX = clickX >= fitted.x && clickX <= fitted.x + fitted.width;
    const withinY = clickY >= fitted.y && clickY <= fitted.y + fitted.height;
    if (!withinX || !withinY) {
      // Clicked in the letterboxed margin around the actual image content.
      return;
    }

    const xFraction = (clickX - fitted.x) / fitted.width;
    const yFraction = (clickY - fitted.y) / fitted.height;

    setInspection({
      xFraction,
      yFraction,
      panelX: event.clientX + 16,
      panelY: event.clientY + 16,
      sharpness: null,
    });
  }

  useEffect(() => {
    if (!inspection) {
      return;
    }

    const sharpness = drawInspection(inspection.xFraction, inspection.yFraction);
    setInspection((current) => (current ? { ...current, sharpness } : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection?.xFraction, inspection?.yFraction, imageUrl]);

  function startDrag(event: ReactMouseEvent<HTMLDivElement>) {
    if (!inspection) {
      return;
    }

    dragOffset.current = { dx: event.clientX - inspection.panelX, dy: event.clientY - inspection.panelY };

    function onMove(moveEvent: MouseEvent) {
      if (!dragOffset.current) {
        return;
      }

      setInspection((current) =>
        current
          ? {
              ...current,
              panelX: moveEvent.clientX - dragOffset.current!.dx,
              panelY: moveEvent.clientY - dragOffset.current!.dy,
            }
          : current,
      );
    }

    function onUp() {
      dragOffset.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={imageUrl}
          alt={alt}
          className="max-h-[520px] w-full cursor-crosshair object-contain"
          onClick={handleImageClick}
        />
      ) : null}

      {inspection ? (
        <div
          className="fixed z-50 grid w-64 gap-2 rounded-lg border border-stone-300 bg-white p-3 shadow-xl"
          style={{ left: inspection.panelX, top: inspection.panelY }}
        >
          <div
            className="-m-1 flex cursor-move items-center justify-between gap-3 rounded p-1"
            onMouseDown={startDrag}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-600">Focus inspection</p>
            <button
              type="button"
              className="text-xs font-medium text-stone-500 hover:text-stone-900"
              onClick={() => setInspection(null)}
            >
              Close
            </button>
          </div>
          <canvas ref={canvasRef} width={220} height={165} className="w-full rounded border border-stone-200 bg-black" />
          <p className="text-xs text-stone-600">
            {inspection.sharpness !== null
              ? `Relative sharpness: ${inspection.sharpness.toFixed(1)}`
              : "Relative sharpness: unavailable"}
          </p>
          <p className="text-[11px] leading-snug text-stone-400">
            Higher is relatively sharper in this region only - not a scientific measurement. Inspection
            only; it does not change the camera&apos;s autofocus target.
          </p>
        </div>
      ) : null}
    </>
  );
}
