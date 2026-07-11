"use client";

import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import {
  CROP_SHAPE_LABELS,
  calculatePreviewCanvasSize,
  changeCropShapePreserveCenter,
  createCropFromDrag,
  cropOrientationLabel,
  cropOutputRatio,
  cropPixelDimensions,
  type CropShape,
  type CropValue,
  inferInitialShapeFromDrag,
  resizeCropFromCorner,
} from "@/lib/cropGeometry";
import { clamp, computeRelativeSharpness, containRect, fractionWithinRect } from "@/lib/imageGeometry";

export type { CropValue } from "@/lib/cropGeometry";

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;

type HandleId = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: Array<{ id: HandleId; cursor: string; x: number; y: number }> = [
  { id: "nw", cursor: "nwse-resize", x: 0, y: 0 },
  { id: "n", cursor: "ns-resize", x: 0.5, y: 0 },
  { id: "ne", cursor: "nesw-resize", x: 1, y: 0 },
  { id: "e", cursor: "ew-resize", x: 1, y: 0.5 },
  { id: "se", cursor: "nwse-resize", x: 1, y: 1 },
  { id: "s", cursor: "ns-resize", x: 0.5, y: 1 },
  { id: "sw", cursor: "nesw-resize", x: 0, y: 1 },
  { id: "w", cursor: "ew-resize", x: 0, y: 0.5 },
];

const CORNER_HANDLES = HANDLES.filter((handle) => ["nw", "ne", "se", "sw"].includes(handle.id));
const SHAPES: CropShape[] = ["16:9", "9:16", "1:1", "free"];
const LIMITED_DETAIL_THRESHOLD = 160;

type DragState =
  | { kind: "create"; startX: number; startY: number }
  | { kind: "move"; startX: number; startY: number; origin: CropValue }
  | { kind: "resize"; handle: HandleId; startX: number; startY: number; origin: CropValue }
  | { kind: "pan"; startClientX: number; startClientY: number; origin: { x: number; y: number } };

export function PlantCropEditor({
  imageUrl,
  value,
  visualAspectRatio = null,
  onChange,
  onVisualAspectRatioChange,
}: {
  imageUrl: string;
  value: CropValue | null;
  visualAspectRatio?: CropShape | null;
  onChange: (crop: CropValue | null) => void;
  onVisualAspectRatioChange?: (shape: CropShape) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  // Effective on-screen scale relative to "fit" (1 = image fits the container exactly).
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const [crop, setCrop] = useState<CropValue | null>(value);
  const [shape, setShape] = useState<CropShape>(visualAspectRatio ?? "free");
  const [shapeWasExplicitlySelected, setShapeWasExplicitlySelected] = useState(Boolean(visualAspectRatio));
  const [sharpness, setSharpness] = useState<number | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 240, height: 240 });

  useEffect(() => {
    setCrop(value);
  }, [value]);

  useEffect(() => {
    setShape(visualAspectRatio ?? "free");
    setShapeWasExplicitlySelected(Boolean(visualAspectRatio));
  }, [visualAspectRatio]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const fit =
    containerSize.width > 0 && naturalSize.width > 0
      ? containRect(containerSize.width, containerSize.height, naturalSize.width, naturalSize.height)
      : null;
  const baseScale = fit && naturalSize.width > 0 ? fit.width / naturalSize.width : 1;
  const actualSizeZoom = baseScale > 0 ? 1 / baseScale : 1;

  function pointFromClient(clientX: number, clientY: number) {
    const stage = stageRef.current;
    if (!stage) {
      return null;
    }

    return fractionWithinRect(clientX, clientY, stage.getBoundingClientRect());
  }

  function handleBackgroundPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);

    if (panMode) {
      dragRef.current = { kind: "pan", startClientX: event.clientX, startClientY: event.clientY, origin: pan };
      return;
    }

    const point = pointFromClient(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    dragRef.current = { kind: "create", startX: point.x, startY: point.y };
    setCrop(null);
  }

  function handleCropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (panMode || !crop) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromClient(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    dragRef.current = { kind: "move", startX: point.x, startY: point.y, origin: crop };
  }

  function handleHandlePointerDown(handle: HandleId) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!crop) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      const point = pointFromClient(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      dragRef.current = { kind: "resize", handle, startX: point.x, startY: point.y, origin: crop };
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    if (drag.kind === "pan") {
      setPan({
        x: drag.origin.x + (event.clientX - drag.startClientX),
        y: drag.origin.y + (event.clientY - drag.startClientY),
      });
      return;
    }

    const point = pointFromClient(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    if (drag.kind === "create") {
      const activeShape =
        shapeWasExplicitlySelected || shape !== "free"
          ? shape
          : inferInitialShapeFromDrag({ x: drag.startX, y: drag.startY }, point);

      if (activeShape !== shape) {
        setShape(activeShape);
      }

      setCrop(
        createCropFromDrag(
          { x: drag.startX, y: drag.startY },
          point,
          activeShape,
          naturalSize.width > 0 ? naturalSize : { width: 1, height: 1 },
        ),
      );
      return;
    }

    if (drag.kind === "move") {
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      const cropX = clamp(drag.origin.cropX + dx, 0, 1 - drag.origin.cropWidth);
      const cropY = clamp(drag.origin.cropY + dy, 0, 1 - drag.origin.cropHeight);
      setCrop({ ...drag.origin, cropX, cropY });
      return;
    }

    setCrop(
      resizeCropFromCorner(
        drag.origin,
        drag.handle,
        point,
        shape,
        naturalSize.width > 0 ? naturalSize : { width: 1, height: 1 },
      ),
    );
  }

  function finishDrag() {
    const drag = dragRef.current;
    dragRef.current = null;

    if (!drag || drag.kind === "pan") {
      return;
    }

    setCrop((current) => {
      if (current && (current.cropWidth <= 0.01 || current.cropHeight <= 0.01)) {
        onChange(null);
        return null;
      }

      onChange(current);
      return current;
    });
  }

  function zoomIn() {
    setZoom((current) => Math.min(MAX_ZOOM, current * ZOOM_STEP));
  }

  function zoomOut() {
    setZoom((current) => Math.max(MIN_ZOOM, current / ZOOM_STEP));
  }

  /** Shows the image at its true 1:1 pixel size (may exceed the container). */
  function resetZoom() {
    setZoom(actualSizeZoom);
    setPan({ x: 0, y: 0 });
  }

  /** Fits the whole image inside the container. */
  function fitImage() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function selectShape(nextShape: CropShape) {
    setShape(nextShape);
    setShapeWasExplicitlySelected(true);
    onVisualAspectRatioChange?.(nextShape);

    if (crop && naturalSize.width > 0 && nextShape !== "free") {
      const nextCrop = changeCropShapePreserveCenter(crop, nextShape, naturalSize);
      setCrop(nextCrop);
      onChange(nextCrop);
    }
  }

  // Recompute the magnified preview and sharpness indicator whenever the
  // crop or source image changes - independent of zoom/pan, since it reads
  // directly from the underlying <img> in its natural pixel space.
  useEffect(() => {
    const img = imgRef.current;
    const canvas = previewCanvasRef.current;
    if (!img || !canvas || !crop || !img.naturalWidth || !img.naturalHeight) {
      setSharpness(null);
      return;
    }

    const sx = crop.cropX * img.naturalWidth;
    const sy = crop.cropY * img.naturalHeight;
    const sw = Math.max(1, crop.cropWidth * img.naturalWidth);
    const sh = Math.max(1, crop.cropHeight * img.naturalHeight);
    const nextPreviewSize = calculatePreviewCanvasSize(crop, {
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

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, nextPreviewSize.width, nextPreviewSize.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, nextPreviewSize.width, nextPreviewSize.height);

    try {
      setSharpness(computeRelativeSharpness(ctx.getImageData(0, 0, nextPreviewSize.width, nextPreviewSize.height)));
    } catch {
      setSharpness(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop?.cropX, crop?.cropY, crop?.cropWidth, crop?.cropHeight, imageUrl]);

  const visibleHandles = shape === "free" ? HANDLES : CORNER_HANDLES;
  const sourceDimensions = crop && naturalSize.width > 0 ? cropPixelDimensions(crop, naturalSize) : null;
  const outputRatio = crop && naturalSize.width > 0 ? cropOutputRatio(crop, naturalSize) : null;
  const limitedDetail =
    sourceDimensions !== null &&
    (sourceDimensions.width < LIMITED_DETAIL_THRESHOLD || sourceDimensions.height < LIMITED_DETAIL_THRESHOLD);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="button-secondary" onClick={zoomOut}>
          Zoom Out
        </button>
        <button type="button" className="button-secondary" onClick={zoomIn}>
          Zoom In
        </button>
        <button type="button" className="button-secondary" onClick={resetZoom}>
          Reset Zoom
        </button>
        <button type="button" className="button-secondary" onClick={fitImage}>
          Fit Image
        </button>
        <label className="ml-2 flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={panMode} onChange={(event) => setPanMode(event.target.checked)} />
          Pan
        </label>
      </div>

      <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Crop shape">
          {SHAPES.map((item) => (
            <button
              key={item}
              type="button"
              className={item === shape ? "button" : "button-secondary"}
              onClick={() => selectShape(item)}
              aria-pressed={item === shape}
            >
              {CROP_SHAPE_LABELS[item]}
            </button>
          ))}
        </div>
        <p className="text-xs text-stone-600">
          Changing the plant visual aspect ratio changes the editing default only. Existing saved crops keep
          rendering from their stored rectangles until edited.
        </p>
      </div>

      <div
        ref={containerRef}
        className="relative h-[min(420px,30vh)] min-h-[180px] w-full overflow-hidden rounded-md bg-black"
      >
        {/* Always mounted (unlike the visible image below, which only
            renders once `fit` is known) purely so its onLoad can report
            naturalWidth/naturalHeight - otherwise fit could never become
            available in the first place. */}
        {naturalSize.width === 0 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            className="hidden"
            onLoad={(event) => {
              const img = event.currentTarget;
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
        ) : null}

        {fit ? (
          <div
            ref={stageRef}
            data-testid="crop-editor-stage"
            className={panMode ? "absolute cursor-grab active:cursor-grabbing" : "absolute cursor-crosshair"}
            style={{
              left: fit.x,
              top: fit.y,
              width: fit.width,
              height: fit.height,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
            onPointerDown={handleBackgroundPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={imageUrl}
              alt="Crop source"
              draggable={false}
              className="block h-full w-full select-none"
              onLoad={(event) => {
                const img = event.currentTarget;
                setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
              }}
            />

            {crop ? (
              <div
                className="absolute border-2 border-cyan-300 bg-cyan-300/20"
                style={{
                  left: `${crop.cropX * 100}%`,
                  top: `${crop.cropY * 100}%`,
                  width: `${crop.cropWidth * 100}%`,
                  height: `${crop.cropHeight * 100}%`,
                  cursor: panMode ? undefined : "move",
                }}
                onPointerDown={handleCropPointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
              >
                {!panMode
                  ? visibleHandles.map((handle) => (
                      <div
                        key={handle.id}
                        className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-600 bg-white"
                        style={{
                          left: `${handle.x * 100}%`,
                          top: `${handle.y * 100}%`,
                          cursor: handle.cursor,
                        }}
                        onPointerDown={handleHandlePointerDown(handle.id)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishDrag}
                        onPointerCancel={finishDrag}
                      />
                    ))
                  : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {!crop ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm text-stone-300">
            Drag on the image to draw a crop.
          </p>
        ) : null}
      </div>

      {crop ? (
        <div className="flex flex-wrap items-center gap-3">
          <canvas
            ref={previewCanvasRef}
            width={previewSize.width}
            height={previewSize.height}
            data-testid="crop-preview-canvas"
            className="rounded border border-stone-200 bg-black"
          />
          <div className="text-sm text-stone-600">
            <p className="font-medium text-stone-800">
              {sourceDimensions ? cropOrientationLabel(crop, naturalSize, shape) : CROP_SHAPE_LABELS[shape]}
            </p>
            {sourceDimensions && outputRatio ? (
              <p>
                Source crop: {sourceDimensions.width} x {sourceDimensions.height} px
              </p>
            ) : null}
            {outputRatio ? <p>Crop ratio: {outputRatio.toFixed(2)}:1</p> : null}
            <p>{sharpness !== null ? `Relative sharpness: ${sharpness.toFixed(1)}` : "Relative sharpness: unavailable"}</p>
            <p className="text-xs text-stone-400">
              Higher is relatively sharper for this crop only - not a scientific measurement.
            </p>
            {limitedDetail ? (
              <p className="mt-1 text-xs font-medium text-amber-700">
                This crop contains limited source detail and may appear blurry when enlarged.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setCrop(null);
              onChange(null);
            }}
          >
            Remove Crop
          </button>
        </div>
      ) : null}
    </div>
  );
}
