import path from "node:path";

export function defaultProjectPhotoDirectory(projectId: string) {
  return path.resolve(process.cwd(), "data", "projects", projectId, "photos");
}

export function defaultCaptureSourceDirectory(captureSourceId: string) {
  return path.resolve(process.cwd(), "data", "capture-sources", captureSourceId, "source-photos");
}
