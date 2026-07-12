import path from "node:path";
import { resolveCaptureSourcesDataDir, resolveProjectsDataDir } from "./paths";

export function defaultProjectPhotoDirectory(projectId: string) {
  return path.join(resolveProjectsDataDir(), projectId, "photos");
}

export function defaultCaptureSourceDirectory(captureSourceId: string) {
  return path.join(resolveCaptureSourcesDataDir(), captureSourceId, "source-photos");
}
