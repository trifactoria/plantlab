import { isDirectoryUsable } from "./projectPaths.server";
import { validateCaptureConfig, type CaptureConfigInput } from "./captureValidation";

export type CaptureEligibilityProject = CaptureConfigInput & {
  captureEnabled: boolean;
};

export type CaptureEligibilityResult = {
  eligible: boolean;
  errors: string[];
};

/**
 * Full eligibility check including whether the local photo directory can
 * actually be accessed (or, if missing, created later) on disk. Used by
 * the capture service and by API routes that enable scheduled capture.
 * This runs far more often than an actual capture (e.g. every
 * /api/service-status poll, for every project, regardless of whether it's
 * capture-enabled) - isDirectoryUsable() is read-only and never creates
 * the directory. See projectPaths.server.ts.
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
