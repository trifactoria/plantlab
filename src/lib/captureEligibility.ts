import { mkdir } from "node:fs/promises";
import { validateCaptureConfig, type CaptureConfigInput } from "./captureValidation";

export type CaptureEligibilityProject = CaptureConfigInput & {
  captureEnabled: boolean;
};

export type CaptureEligibilityResult = {
  eligible: boolean;
  errors: string[];
};

async function isDirectoryUsable(directory: string) {
  try {
    await mkdir(directory, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Full eligibility check including whether the local photo directory can
 * actually be created/accessed on disk. Used by the capture service and by
 * API routes that enable scheduled capture.
 */
export async function checkCaptureEligibility(
  project: CaptureEligibilityProject,
): Promise<CaptureEligibilityResult> {
  const errors = validateCaptureConfig(project);

  if (project.localPhotoDirectory && project.localPhotoDirectory.trim().length > 0) {
    const usable = await isDirectoryUsable(project.localPhotoDirectory);
    if (!usable) {
      errors.push(`Local photo directory is not usable: ${project.localPhotoDirectory}`);
    }
  }

  if (!project.captureEnabled) {
    errors.push("Scheduled capture is not enabled for this project.");
  }

  return { eligible: errors.length === 0, errors };
}

export { validateCaptureConfig } from "./captureValidation";
