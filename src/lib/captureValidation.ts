import { validateCaptureWindowConfig, type CaptureWindowConfig } from "./schedule";

export type CaptureConfigInput = {
  captureStartAt: Date | string | null;
  photoIntervalMinutes: number;
  cameraDevice: string | null;
  localPhotoDirectory: string | null;
  isTestProject?: boolean;
} & CaptureWindowConfig;

/**
 * Structural checks only (no disk access), safe to run in the browser.
 * Used to show validation errors as the user edits a form, and reused
 * server-side as the first pass before checking the photo directory.
 */
export function validateCaptureConfig(project: CaptureConfigInput): string[] {
  const errors: string[] = [];

  if (!project.captureStartAt) {
    errors.push("Schedule start date/time is required for scheduled capture.");
  }

  if (!Number.isInteger(project.photoIntervalMinutes) || project.photoIntervalMinutes <= 0) {
    errors.push("Photo interval must be a positive whole number of minutes.");
  }

  if (!project.cameraDevice) {
    errors.push("A camera must be selected for scheduled capture.");
  }

  if (!project.localPhotoDirectory || project.localPhotoDirectory.trim().length === 0) {
    errors.push("A local photo directory is required for scheduled capture.");
  }

  if (project.isTestProject) {
    errors.push("Test projects cannot enable scheduled capture.");
  }

  errors.push(...validateCaptureWindowConfig(project));

  return errors;
}
