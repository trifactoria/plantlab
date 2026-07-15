import { stat } from "node:fs/promises";
import sharp from "sharp";

export type ImageValidationStats = {
  width: number;
  height: number;
  format: string;
  byteSize: number;
  lumaMean: number;
  lumaStdDev: number;
  lumaRange: number;
  lumaEntropy: number;
};

export type ImageValidationResult = {
  ok: true;
  stats: ImageValidationStats;
};

export class ImageValidationError extends Error {
  readonly code: string;
  readonly stats?: ImageValidationStats;

  constructor(code: string, message: string, stats?: ImageValidationStats) {
    super(message);
    this.name = "ImageValidationError";
    this.code = code;
    this.stats = stats;
  }
}

function minimumExpectedJpegBytes(width: number, height: number) {
  return Math.max(12_000, Math.round(width * height * 0.03));
}

function lumaStats(rgb: Buffer) {
  const values: number[] = [];
  let sum = 0;
  let min = 255;
  let max = 0;
  const histogram = new Array<number>(256).fill(0);

  for (let index = 0; index + 2 < rgb.length; index += 3) {
    const luma = Math.round(0.2126 * rgb[index] + 0.7152 * rgb[index + 1] + 0.0722 * rgb[index + 2]);
    values.push(luma);
    sum += luma;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    histogram[luma] += 1;
  }

  const count = Math.max(1, values.length);
  const mean = sum / count;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  const entropy = histogram.reduce((acc, bucket) => {
    if (bucket === 0) return acc;
    const p = bucket / count;
    return acc - p * Math.log2(p);
  }, 0);

  return {
    mean,
    stdDev: Math.sqrt(variance),
    range: max - min,
    entropy,
  };
}

async function inspectSharpImage(
  input: Buffer | string,
  byteSize: number,
): Promise<ImageValidationStats> {
  let metadata;
  try {
    metadata = await sharp(input, { failOn: "error" }).metadata();
  } catch (error) {
    throw new ImageValidationError(
      "camera-jpeg-invalid",
      `Image could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new ImageValidationError("camera-jpeg-invalid", "Image dimensions or format could not be read.");
  }

  let sampled;
  try {
    sampled = await sharp(input, { failOn: "error" })
      .rotate()
      .resize(64, 64, { fit: "fill" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer();
  } catch (error) {
    throw new ImageValidationError(
      "camera-jpeg-invalid",
      `Image failed full decode validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const luma = lumaStats(sampled);
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    byteSize,
    lumaMean: Number(luma.mean.toFixed(2)),
    lumaStdDev: Number(luma.stdDev.toFixed(2)),
    lumaRange: luma.range,
    lumaEntropy: Number(luma.entropy.toFixed(3)),
  };
}

function validateStats(
  stats: ImageValidationStats,
  options: { expectedWidth?: number; expectedHeight?: number; expectedFormat?: "jpeg" | "png"; allowLowDetail?: boolean } = {},
) {
  if (options.expectedWidth && stats.width !== options.expectedWidth) {
    throw new ImageValidationError(
      "camera-dimension-mismatch",
      `Image width ${stats.width} did not match expected width ${options.expectedWidth}.`,
      stats,
    );
  }
  if (options.expectedHeight && stats.height !== options.expectedHeight) {
    throw new ImageValidationError(
      "camera-dimension-mismatch",
      `Image height ${stats.height} did not match expected height ${options.expectedHeight}.`,
      stats,
    );
  }
  if (options.expectedFormat && stats.format !== options.expectedFormat) {
    throw new ImageValidationError(
      "camera-mime-mismatch",
      `Image format ${stats.format} did not match expected format ${options.expectedFormat}.`,
      stats,
    );
  }
  if (stats.byteSize <= 0) {
    throw new ImageValidationError("camera-output-empty", "Image file is empty.", stats);
  }

  const cameraScaleFrame = stats.width * stats.height >= 300_000;
  const suspiciouslySmall =
    cameraScaleFrame && stats.format === "jpeg" && stats.byteSize < minimumExpectedJpegBytes(stats.width, stats.height);
  const lowDetail = stats.lumaStdDev < 6 || stats.lumaRange < 32 || stats.lumaEntropy < 1.2;
  if (!options.allowLowDetail && suspiciouslySmall && lowDetail) {
    throw new ImageValidationError(
      "camera-frame-corrupt",
      `Image decoded but looked like a corrupt or unsettled frame (${stats.byteSize} bytes, luma stddev ${stats.lumaStdDev}).`,
      stats,
    );
  }
}

export async function validateImageBuffer(
  buffer: Buffer,
  options: { expectedWidth?: number; expectedHeight?: number; expectedFormat?: "jpeg" | "png"; allowLowDetail?: boolean } = {},
): Promise<ImageValidationResult> {
  const stats = await inspectSharpImage(buffer, buffer.length);
  validateStats(stats, options);
  return { ok: true, stats };
}

export async function validateImageFile(
  filePath: string,
  options: { expectedWidth?: number; expectedHeight?: number; expectedFormat?: "jpeg" | "png"; allowLowDetail?: boolean } = {},
): Promise<ImageValidationResult> {
  const file = await stat(filePath).catch(() => null);
  if (!file || file.size <= 0) {
    throw new ImageValidationError("camera-output-empty", "Image file is missing or empty.");
  }
  const stats = await inspectSharpImage(filePath, file.size);
  validateStats(stats, options);
  return { ok: true, stats };
}
