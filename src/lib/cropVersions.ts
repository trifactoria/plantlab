import type { Prisma, PrismaClient } from "@prisma/client";
import { isUniqueConstraintError } from "@/lib/prismaErrors";

export const CROP_ASPECT_RATIO_MODES = ["1:1", "16:9", "9:16", "free"] as const;
export type CropAspectRatioMode = (typeof CROP_ASPECT_RATIO_MODES)[number];

export function isCropAspectRatioMode(value: unknown): value is CropAspectRatioMode {
  return typeof value === "string" && (CROP_ASPECT_RATIO_MODES as readonly string[]).includes(value);
}

export type NormalizedCrop = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

/**
 * PlantPhotoCrop.createdMethod provenance values. "manual" and "propagated"
 * predate this module (the original single-crop editor and its bulk-copy
 * tool, src/lib/plantPhotoCropPropagation.ts); the rest are produced by the
 * crop-version system below.
 */
export const CROP_PROVENANCE = {
  MANUAL: "manual",
  PROPAGATED: "propagated",
  INITIAL_VERSION: "initial_version",
  ACTIVE_VERSION: "active_version",
  REPAIRED: "repaired",
  MANUAL_ADJUSTED: "manual_adjusted",
} as const;

/** Provenance values a version-creation pass is allowed to regenerate (never touches MANUAL/MANUAL_ADJUSTED). */
const REGENERATABLE_PROVENANCE: readonly string[] = [
  CROP_PROVENANCE.PROPAGATED,
  CROP_PROVENANCE.INITIAL_VERSION,
  CROP_PROVENANCE.ACTIVE_VERSION,
  CROP_PROVENANCE.REPAIRED,
];

const MANUAL_PROVENANCE: readonly string[] = [CROP_PROVENANCE.MANUAL, CROP_PROVENANCE.MANUAL_ADJUSTED];

export function isManualProvenance(createdMethod: string): boolean {
  return MANUAL_PROVENANCE.includes(createdMethod);
}

type TxClient = Prisma.TransactionClient;
type AnyClient = PrismaClient | TxClient;

/** Newest active version whose effectiveFrom is at or before `timestamp`, or null if none applies yet. */
export async function resolveActiveCropVersion(
  client: Pick<AnyClient, "plantCropVersion">,
  plantId: string,
  timestamp: Date,
) {
  return client.plantCropVersion.findFirst({
    where: { plantId, active: true, effectiveFrom: { lte: timestamp } },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * Materializes this plant's currently-applicable crop version onto one
 * newly created photo, if a version applies and no crop already exists.
 * Idempotent under retries: a losing concurrent insert (unique
 * [plantId, photoId]) is treated as success, not an error.
 */
export async function materializeCropForNewPhoto(
  prisma: AnyClient,
  plant: { id: string; automaticCropAssignmentEnabled: boolean },
  photo: { id: string; timestamp: Date },
): Promise<boolean> {
  if (!plant.automaticCropAssignmentEnabled) {
    return false;
  }

  const version = await resolveActiveCropVersion(prisma, plant.id, photo.timestamp);
  if (!version) {
    return false;
  }

  try {
    await prisma.plantPhotoCrop.create({
      data: {
        plantId: plant.id,
        photoId: photo.id,
        cropX: version.cropX,
        cropY: version.cropY,
        cropWidth: version.cropWidth,
        cropHeight: version.cropHeight,
        createdMethod: CROP_PROVENANCE.ACTIVE_VERSION,
        cropVersionId: version.id,
      },
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * For a newly created photo, materializes crops for every plant in its
 * project that has an applicable, enabled crop version. This is the one
 * shared hook every production photo-creation path calls - see
 * src/lib/photoIngest.ts. Never overwrites an existing PlantPhotoCrop, and
 * never touches plants/versions from another project (both are scoped by
 * `photo.projectId` through the plant query below).
 */
export async function materializeCropsForNewPhoto(
  prisma: AnyClient,
  photo: { id: string; projectId: string; timestamp: Date },
): Promise<{ plantId: string }[]> {
  const plants = await prisma.plant.findMany({
    where: { projectId: photo.projectId },
    select: { id: true, automaticCropAssignmentEnabled: true },
  });

  const materialized: { plantId: string }[] = [];
  for (const plant of plants) {
    const created = await materializeCropForNewPhoto(prisma, plant, photo);
    if (created) {
      materialized.push({ plantId: plant.id });
    }
  }
  return materialized;
}

export type CreateCropVersionResult = {
  version: { id: string; effectiveFrom: Date };
  materializedCount: number;
  regeneratedCount: number;
  preservedManualCount: number;
};

/**
 * Shared implementation of both "Set initial crop" and "Adjust crop from
 * this frame forward" - the only difference between them is UX framing, not
 * behavior. Creates a new, immutable PlantCropVersion effective at the
 * given photo's timestamp, then materializes/regenerates PlantPhotoCrop
 * rows in the window [effectiveFrom, next existing version's effectiveFrom).
 *
 * Interaction with already-materialized crops in that window:
 * - No existing row -> create one from the new version.
 * - Existing row with auto provenance (propagated/initial/active/repaired)
 *   -> regenerated to match the new version (this is what "propagated
 *   crops may be regenerated from the new version" means).
 * - Existing row with manual provenance -> preserved untouched, UNLESS it
 *   is the exact source photo the user just drew this crop on, which is
 *   always written (that photo's row becomes this version's manual anchor).
 * - Photos before effectiveFrom, or at/after a later existing version's
 *   effectiveFrom, are never touched - earlier crops and later explicit
 *   version boundaries are preserved exactly.
 */
export async function createCropVersionAndMaterialize(
  prisma: PrismaClient,
  input: {
    plantId: string;
    projectId: string;
    crop: NormalizedCrop;
    aspectRatioMode: CropAspectRatioMode;
    sourcePhotoId: string;
    effectiveFrom: Date;
  },
): Promise<CreateCropVersionResult> {
  const { plantId, projectId, crop, aspectRatioMode, sourcePhotoId, effectiveFrom } = input;

  return prisma.$transaction(async (tx) => {
    const isFirstVersion = (await tx.plantCropVersion.count({ where: { plantId } })) === 0;

    const nextVersion = await tx.plantCropVersion.findFirst({
      where: { plantId, active: true, effectiveFrom: { gt: effectiveFrom } },
      orderBy: { effectiveFrom: "asc" },
    });
    const windowEnd = nextVersion?.effectiveFrom;

    const version = await tx.plantCropVersion.create({
      data: {
        plantId,
        projectId,
        cropX: crop.cropX,
        cropY: crop.cropY,
        cropWidth: crop.cropWidth,
        cropHeight: crop.cropHeight,
        aspectRatioMode,
        effectiveFrom,
        sourcePhotoId,
      },
    });

    const windowPhotos = await tx.photo.findMany({
      where: {
        projectId,
        timestamp: windowEnd ? { gte: effectiveFrom, lt: windowEnd } : { gte: effectiveFrom },
      },
      select: { id: true },
      orderBy: { timestamp: "asc" },
    });

    const existingCrops = await tx.plantPhotoCrop.findMany({
      where: { plantId, photoId: { in: windowPhotos.map((photo) => photo.id) } },
    });
    const existingByPhotoId = new Map(existingCrops.map((cropRow) => [cropRow.photoId, cropRow]));

    let materializedCount = 0;
    let regeneratedCount = 0;
    let preservedManualCount = 0;

    for (const photo of windowPhotos) {
      const existing = existingByPhotoId.get(photo.id);
      const isSourcePhoto = photo.id === sourcePhotoId;
      const provenance = isSourcePhoto
        ? isFirstVersion
          ? CROP_PROVENANCE.INITIAL_VERSION
          : CROP_PROVENANCE.MANUAL_ADJUSTED
        : CROP_PROVENANCE.ACTIVE_VERSION;

      if (!existing) {
        await tx.plantPhotoCrop.create({
          data: {
            plantId,
            photoId: photo.id,
            ...crop,
            createdMethod: provenance,
            cropVersionId: version.id,
          },
        });
        materializedCount += 1;
        continue;
      }

      if (isSourcePhoto || REGENERATABLE_PROVENANCE.includes(existing.createdMethod)) {
        await tx.plantPhotoCrop.update({
          where: { id: existing.id },
          data: { ...crop, createdMethod: provenance, cropVersionId: version.id },
        });
        regeneratedCount += 1;
      } else {
        preservedManualCount += 1;
      }
    }

    return { version, materializedCount, regeneratedCount, preservedManualCount };
  });
}

export type RepairResult = {
  added: number;
  skippedExisting: number;
  preservedManual: number;
  noApplicableVersion: number;
  failed: number;
};

/**
 * Idempotent, safe to rerun. Fills only missing PlantPhotoCrop rows for
 * photos at/after the plant's first crop version, using each photo's
 * applicable version. Never overwrites an existing row (manual or
 * otherwise) and never invents a crop for a photo with no applicable
 * version - see the "preferred behavior" doc on createCropVersionAndMaterialize.
 */
export async function repairMissingCrops(prisma: PrismaClient, plantId: string): Promise<RepairResult> {
  const plant = await prisma.plant.findUniqueOrThrow({ where: { id: plantId } });
  const versions = await prisma.plantCropVersion.findMany({
    where: { plantId, active: true },
    orderBy: { effectiveFrom: "asc" },
  });

  if (versions.length === 0) {
    return { added: 0, skippedExisting: 0, preservedManual: 0, noApplicableVersion: 0, failed: 0 };
  }

  const photos = await prisma.photo.findMany({
    where: { projectId: plant.projectId, timestamp: { gte: versions[0].effectiveFrom } },
    select: { id: true, timestamp: true },
    orderBy: { timestamp: "asc" },
  });

  const existingCrops = await prisma.plantPhotoCrop.findMany({ where: { plantId } });
  const existingByPhotoId = new Map(existingCrops.map((crop) => [crop.photoId, crop]));

  let added = 0;
  let skippedExisting = 0;
  let preservedManual = 0;
  let noApplicableVersion = 0;
  let failed = 0;

  for (const photo of photos) {
    const existing = existingByPhotoId.get(photo.id);
    if (existing) {
      skippedExisting += 1;
      if (isManualProvenance(existing.createdMethod)) {
        preservedManual += 1;
      }
      continue;
    }

    // Newest version with effectiveFrom <= photo.timestamp, from the
    // already-fetched ascending list (avoids N extra queries).
    let applicable: (typeof versions)[number] | undefined;
    for (const version of versions) {
      if (version.effectiveFrom.getTime() <= photo.timestamp.getTime()) {
        applicable = version;
      } else {
        break;
      }
    }

    if (!applicable) {
      noApplicableVersion += 1;
      continue;
    }

    try {
      await prisma.plantPhotoCrop.create({
        data: {
          plantId,
          photoId: photo.id,
          cropX: applicable.cropX,
          cropY: applicable.cropY,
          cropWidth: applicable.cropWidth,
          cropHeight: applicable.cropHeight,
          createdMethod: CROP_PROVENANCE.REPAIRED,
          cropVersionId: applicable.id,
        },
      });
      added += 1;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        skippedExisting += 1;
      } else {
        failed += 1;
      }
    }
  }

  return { added, skippedExisting, preservedManual, noApplicableVersion, failed };
}

export type VisualHistoryStatus = {
  totalApplicablePhotos: number;
  materializedCount: number;
  missingCount: number;
  automaticCropAssignmentEnabled: boolean;
  versionCount: number;
};

/** Plant-level completeness summary for the "Visual history: N of M photos" status line. */
export async function computeVisualHistoryStatus(prisma: PrismaClient, plantId: string): Promise<VisualHistoryStatus> {
  const plant = await prisma.plant.findUniqueOrThrow({ where: { id: plantId } });
  const versions = await prisma.plantCropVersion.findMany({
    where: { plantId, active: true },
    orderBy: { effectiveFrom: "asc" },
    select: { id: true, effectiveFrom: true },
  });

  if (versions.length === 0) {
    const materializedCount = await prisma.plantPhotoCrop.count({ where: { plantId } });
    return {
      totalApplicablePhotos: materializedCount,
      materializedCount,
      missingCount: 0,
      automaticCropAssignmentEnabled: plant.automaticCropAssignmentEnabled,
      versionCount: 0,
    };
  }

  const applicablePhotos = await prisma.photo.findMany({
    where: { projectId: plant.projectId, timestamp: { gte: versions[0].effectiveFrom } },
    select: { id: true },
  });
  const applicableIds = applicablePhotos.map((photo) => photo.id);
  const materializedCount = await prisma.plantPhotoCrop.count({
    where: { plantId, photoId: { in: applicableIds } },
  });

  return {
    totalApplicablePhotos: applicableIds.length,
    materializedCount,
    missingCount: Math.max(0, applicableIds.length - materializedCount),
    automaticCropAssignmentEnabled: plant.automaticCropAssignmentEnabled,
    versionCount: versions.length,
  };
}
