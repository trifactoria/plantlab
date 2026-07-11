import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { CaptureSource, Prisma, PrismaClient, ProjectViewport, SourceCapture } from "@prisma/client";
import sharp from "sharp";
import { nextCapturePath } from "./camera";
import { applyOrientation, parseRotation } from "./orientation";
import { createPhotoRecord } from "./photoIngest";
import { prisma } from "./prisma";

type TxClient = Prisma.TransactionClient;
type AnyClient = PrismaClient | TxClient;

/**
 * Newest active viewport per project for this capture source, at or before
 * `timestamp`. Mirrors resolveActiveCropVersion in cropVersions.ts exactly
 * (newest row with active=true and effectiveFrom <= timestamp), generalized
 * across every project that has ever claimed a rectangle of this source
 * rather than a single plant.
 */
export async function resolveActiveViewportsForSource(
  client: Pick<AnyClient, "projectViewport">,
  captureSourceId: string,
  timestamp: Date,
): Promise<ProjectViewport[]> {
  return client.projectViewport.findMany({
    where: { captureSourceId, active: true, effectiveFrom: { lte: timestamp } },
    orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
    distinct: ["projectId"],
  });
}

function clampRegion(
  left: number,
  top: number,
  width: number,
  height: number,
  boundsWidth: number,
  boundsHeight: number,
) {
  const clampedLeft = Math.min(Math.max(0, Math.round(left)), Math.max(0, boundsWidth - 1));
  const clampedTop = Math.min(Math.max(0, Math.round(top)), Math.max(0, boundsHeight - 1));
  const clampedWidth = Math.max(1, Math.min(Math.round(width), boundsWidth - clampedLeft));
  const clampedHeight = Math.max(1, Math.min(Math.round(height), boundsHeight - clampedTop));

  return { left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight };
}

async function cropDerivedImage(
  sourceCapture: SourceCapture & { captureSource: CaptureSource },
  viewport: ProjectViewport,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const rawBuffer = await readFile(sourceCapture.originalPath);
  const oriented = applyOrientation(sharp(rawBuffer), {
    rotation: parseRotation(sourceCapture.captureSource.rotation),
    flipHorizontal: sourceCapture.captureSource.flipHorizontal,
    flipVertical: sourceCapture.captureSource.flipVertical,
  });

  const region = clampRegion(
    viewport.cropX * sourceCapture.workingWidth,
    viewport.cropY * sourceCapture.workingHeight,
    viewport.cropWidth * sourceCapture.workingWidth,
    viewport.cropHeight * sourceCapture.workingHeight,
    sourceCapture.workingWidth,
    sourceCapture.workingHeight,
  );

  const { data, info } = await oriented.extract(region).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export type ViewportFanOutProjectResult = {
  projectId: string;
  projectName: string;
  viewportId: string;
  status: "success" | "failed";
  photoId?: string;
  derivedWidth?: number;
  derivedHeight?: number;
  errorMessage?: string;
};

export type ViewportFanOutResult = {
  sourceCaptureId: string;
  sourceWidth: number;
  sourceHeight: number;
  projectResults: ViewportFanOutProjectResult[];
};

/**
 * The one shared fan-out workflow for a shared CaptureSource: resolves every
 * project's currently-applicable viewport for this capture, crops one
 * derived image per project from the (already-transformed) working frame,
 * and registers each through the existing shared photo-ingest pipeline
 * (createPhotoRecord) - so downstream project/plant code never needs to
 * know a photo came from a shared shelf camera rather than direct capture
 * or upload.
 *
 * Each project is isolated in its own try/catch: a failure generating one
 * project's derived photo (a bad crop region, a full disk, a DB error) is
 * recorded in that project's result entry and never prevents, rolls back,
 * or gets misreported against any other project's result.
 */
export async function runViewportFanOut(sourceCaptureId: string): Promise<ViewportFanOutResult> {
  const sourceCapture = await prisma.sourceCapture.findUnique({
    where: { id: sourceCaptureId },
    include: { captureSource: true },
  });

  if (!sourceCapture) {
    throw new Error(`Source capture not found: ${sourceCaptureId}`);
  }

  const viewports = await resolveActiveViewportsForSource(prisma, sourceCapture.captureSourceId, sourceCapture.timestamp);
  const projectResults: ViewportFanOutProjectResult[] = [];

  for (const viewport of viewports) {
    let projectName = viewport.projectId;

    try {
      const project = await prisma.project.findUnique({ where: { id: viewport.projectId } });
      if (!project) {
        // The viewport's project was deleted after the viewport was created; nothing to fan out to.
        continue;
      }
      projectName = project.name;

      const derived = await cropDerivedImage(sourceCapture, viewport);
      await mkdir(project.localPhotoDirectory, { recursive: true });
      const savedPath = await nextCapturePath(project.localPhotoDirectory, sourceCapture.timestamp);
      await sharp(derived.buffer).toFile(savedPath);

      try {
        const { photo } = await createPhotoRecord(prisma, {
          projectId: project.id,
          filename: path.basename(savedPath),
          path: savedPath,
          // Preserve the source capture's timestamp - this is when the
          // frame was actually taken, not when this derived photo was cut.
          timestamp: sourceCapture.timestamp,
          sourceCaptureId: sourceCapture.id,
          viewportId: viewport.id,
        });

        projectResults.push({
          projectId: project.id,
          projectName,
          viewportId: viewport.id,
          status: "success",
          photoId: photo.id,
          derivedWidth: derived.width,
          derivedHeight: derived.height,
        });
      } catch (error) {
        await unlink(savedPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fan-out failed for this project.";
      projectResults.push({
        projectId: viewport.projectId,
        projectName,
        viewportId: viewport.id,
        status: "failed",
        errorMessage: message,
      });
    }
  }

  return {
    sourceCaptureId: sourceCapture.id,
    sourceWidth: sourceCapture.workingWidth,
    sourceHeight: sourceCapture.workingHeight,
    projectResults,
  };
}
