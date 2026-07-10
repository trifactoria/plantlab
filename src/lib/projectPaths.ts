import path from "node:path";

export function defaultProjectPhotoDirectory(projectId: string) {
  return path.resolve(process.cwd(), "data", "projects", projectId, "photos");
}
