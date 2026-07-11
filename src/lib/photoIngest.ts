import type { Photo, PrismaClient } from "@prisma/client";
import { materializeCropsForNewPhoto } from "@/lib/cropVersions";

export type CreatePhotoInput = {
  projectId: string;
  filename: string;
  path: string;
  timestamp: Date;
  notes?: string | null;
  /** Optional provenance when this photo was derived from a shared CaptureSource's frame via a ProjectViewport. */
  sourceCaptureId?: string | null;
  viewportId?: string | null;
};

export type CreatePhotoResult = {
  photo: Photo;
  materializedCropCount: number;
};

/**
 * The one shared photo-creation workflow every production photo-creation
 * path uses (scheduled capture, manual capture, upload, scan/import - see
 * src/lib/camera.ts, the upload route, and the scan route). Creates the
 * Photo row and materializes each applicable plant's active crop version
 * onto it, atomically, so visual-history playback never observes a photo
 * without its crops (or vice versa).
 *
 * This function only touches the database. Callers own the filesystem: the
 * photo file must already exist at `path` before calling this, and if this
 * throws, a caller that just wrote that file itself is responsible for
 * deleting it (a caller that merely discovered a pre-existing file, like
 * the scan/import path, must NOT delete it - that would destroy user data
 * unrelated to this operation).
 */
export async function createPhotoRecord(
  prisma: PrismaClient,
  input: CreatePhotoInput,
): Promise<CreatePhotoResult> {
  return prisma.$transaction(async (tx) => {
    const photo = await tx.photo.create({
      data: {
        projectId: input.projectId,
        filename: input.filename,
        path: input.path,
        timestamp: input.timestamp,
        notes: input.notes ?? null,
        sourceCaptureId: input.sourceCaptureId ?? null,
        viewportId: input.viewportId ?? null,
      },
    });

    const materialized = await materializeCropsForNewPhoto(tx, photo);

    return { photo, materializedCropCount: materialized.length };
  });
}
