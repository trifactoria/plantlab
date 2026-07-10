export type NormalizedCrop = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

const CROP_FIELDS = ["cropX", "cropY", "cropWidth", "cropHeight"] as const;

export function cropFromBody(body: unknown): NormalizedCrop | null | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const values = CROP_FIELDS.map((field) => record[field]);
  const presentCount = values.filter((value) => value !== undefined && value !== null && value !== "").length;

  if (presentCount === 0) {
    return values.some((value) => value === null) ? null : undefined;
  }

  if (presentCount !== CROP_FIELDS.length) {
    throw new Error("Crop must include x, y, width, and height, or no crop fields.");
  }

  const crop = {
    cropX: Number(record.cropX),
    cropY: Number(record.cropY),
    cropWidth: Number(record.cropWidth),
    cropHeight: Number(record.cropHeight),
  };

  validateCrop(crop);
  return crop;
}

export function validateCrop(crop: NormalizedCrop | null) {
  if (!crop) {
    return;
  }

  for (const [field, value] of Object.entries(crop)) {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} must be a finite number`);
    }
  }

  if (crop.cropX < 0 || crop.cropY < 0) {
    throw new Error("Crop x and y must be zero or greater");
  }

  if (crop.cropWidth <= 0 || crop.cropHeight <= 0) {
    throw new Error("Crop width and height must be greater than zero");
  }

  if (crop.cropX + crop.cropWidth > 1 || crop.cropY + crop.cropHeight > 1) {
    throw new Error("Crop must fit inside the source photo");
  }
}

export function cropData(crop: NormalizedCrop | null | undefined) {
  if (crop === undefined) {
    return {};
  }

  if (crop === null) {
    return {
      cropX: null,
      cropY: null,
      cropWidth: null,
      cropHeight: null,
    };
  }

  return crop;
}

export function eventHasCrop(event: {
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
}) {
  return (
    event.cropX !== null &&
    event.cropY !== null &&
    event.cropWidth !== null &&
    event.cropHeight !== null
  );
}
