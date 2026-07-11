import type { CameraFormat } from "./v4l2";

export type ResolutionCandidate = { width: number; height: number };

/** The resolutions PlantLab offers to compare, in preference order. */
export const CANDIDATE_RESOLUTIONS: ResolutionCandidate[] = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
];

/** Restricts the candidate list to what this camera actually reports for the given pixel format. */
export function supportedCandidateResolutions(
  formats: CameraFormat[],
  pixelFormat: string,
): ResolutionCandidate[] {
  const format = formats.find((candidate) => candidate.pixelFormat === pixelFormat);

  if (!format) {
    return [];
  }

  return CANDIDATE_RESOLUTIONS.filter((candidate) =>
    format.resolutions.some(
      (resolution) => resolution.width === candidate.width && resolution.height === candidate.height,
    ),
  );
}

export type ResolutionTestResult = {
  width: number;
  height: number;
  byteSize: number;
  durationMs: number;
  imageBase64: string;
};

export type ResolutionCaptureFn = (width: number, height: number) => Promise<Buffer>;

/**
 * Captures one temporary, non-gallery test frame per candidate resolution,
 * strictly sequentially (never two resolutions open on the camera at once).
 */
export async function compareResolutions(
  candidates: ResolutionCandidate[],
  capture: ResolutionCaptureFn,
): Promise<ResolutionTestResult[]> {
  const results: ResolutionTestResult[] = [];

  for (const candidate of candidates) {
    const startedAt = Date.now();
    const buffer = await capture(candidate.width, candidate.height);
    const durationMs = Date.now() - startedAt;

    results.push({
      width: candidate.width,
      height: candidate.height,
      byteSize: buffer.length,
      durationMs,
      imageBase64: buffer.toString("base64"),
    });
  }

  return results;
}
