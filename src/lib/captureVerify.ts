import sharp from "sharp";
import { validateImageBuffer } from "./imageValidation";

export type DimensionVerification = {
  requestedWidth: number;
  requestedHeight: number;
  actualWidth: number;
  actualHeight: number;
  matched: boolean;
  byteSize: number;
};

/**
 * Reads back a just-captured image's real pixel dimensions via Sharp,
 * rather than trusting the width/height that were requested from ffmpeg.
 * A camera or driver can silently fall back to a lower mode than requested
 * (e.g. an unsupported 4K/format combination) - this is the one place that
 * catches that instead of registering a mismatched Photo or SourceCapture.
 */
export async function verifyCapturedDimensions(
  buffer: Buffer,
  requested: { width: number; height: number },
): Promise<DimensionVerification> {
  const validation = await validateImageBuffer(buffer, {
    expectedWidth: requested.width,
    expectedHeight: requested.height,
    expectedFormat: "jpeg",
  });
  const metadata = await sharp(buffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read captured image dimensions.");
  }

  return {
    requestedWidth: requested.width,
    requestedHeight: requested.height,
    actualWidth: metadata.width,
    actualHeight: metadata.height,
    matched: metadata.width === requested.width && metadata.height === requested.height,
    byteSize: validation.stats.byteSize,
  };
}
