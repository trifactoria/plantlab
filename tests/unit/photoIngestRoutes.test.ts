import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST as postScan } from "../../src/app/api/projects/[projectId]/photos/scan/route";
import { POST as postUpload } from "../../src/app/api/projects/[projectId]/photos/upload/route";
import { POST as postCropVersion } from "../../src/app/api/plants/[plantId]/crop-versions/route";
import { createPhotoRecord } from "../../src/lib/photoIngest";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";
import { createRealPhoto, createTestPlant } from "./helpers/testPlantPhoto";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("shared photo-ingest workflow", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function projectWithActiveCropVersion() {
    const project = await createTestProject(prisma);
    cleanup.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));
    const plant = await createTestPlant(prisma, project.id);
    const { photo: seedPhoto, directory } = await createRealPhoto(prisma, project.id, {
      timestamp: new Date("2026-07-01T08:00:00.000Z"),
    });
    cleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));

    await postCropVersion(
      jsonRequest(`http://localhost/api/plants/${plant.id}/crop-versions`, {
        sourcePhotoId: seedPhoto.id,
        cropX: 0.1,
        cropY: 0.1,
        cropWidth: 0.2,
        cropHeight: 0.2,
        aspectRatioMode: "1:1",
      }),
      { params: Promise.resolve({ plantId: plant.id }) },
    );

    return { project, plant };
  }

  it("createPhotoRecord (the shared function every path calls) materializes applicable crops atomically", async () => {
    const { project, plant } = await projectWithActiveCropVersion();
    const { directory } = await createRealPhoto(prisma, project.id, { timestamp: new Date("2026-07-05T08:00:00.000Z") });
    cleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));
    const filePath = path.join(directory, "shared-workflow.jpg");
    await writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const { photo, materializedCropCount } = await createPhotoRecord(prisma, {
      projectId: project.id,
      filename: "shared-workflow.jpg",
      path: filePath,
      timestamp: new Date("2026-07-06T08:00:00.000Z"),
    });

    expect(materializedCropCount).toBe(1);
    const crop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo.id } },
    });
    expect(crop).not.toBeNull();
    expect(crop?.createdMethod).toBe("active_version");
  });

  it("upload route uses the shared workflow and materializes crops for the uploaded photo", async () => {
    const { project, plant } = await projectWithActiveCropVersion();

    const file = new File([Buffer.from(TINY_PNG_BASE64, "base64")], "new-capture.png", { type: "image/png" });
    const formData = new FormData();
    formData.append("files", file);
    formData.append("lastModified-0", String(new Date("2026-07-07T09:00:00.000Z").getTime()));

    const request = new Request(`http://localhost/api/projects/${project.id}/photos/upload`, {
      method: "POST",
      body: formData,
    });

    const response = await postUpload(request, { params: Promise.resolve({ projectId: project.id }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.results[0].success).toBe(true);
    const photoId = payload.results[0].photoId as string;

    const crop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId } },
    });
    expect(crop).not.toBeNull();
    expect(crop?.cropVersionId).not.toBeNull();
  });

  it("scan route uses the shared workflow and materializes crops for imported files, without touching the source file", async () => {
    const { project, plant } = await projectWithActiveCropVersion();

    const fileBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
    const filePath = path.join(project.localPhotoDirectory, "2026-07-08_09-00-00.jpg");
    await writeFile(filePath, fileBuffer);

    const response = await postScan(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ projectId: project.id }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.imported).toBe(1);

    const photo = await prisma.photo.findFirstOrThrow({ where: { projectId: project.id, path: filePath } });
    const crop = await prisma.plantPhotoCrop.findUnique({
      where: { plantId_photoId: { plantId: plant.id, photoId: photo.id } },
    });
    expect(crop).not.toBeNull();

    const { readFile } = await import("node:fs/promises");
    const stillOnDisk = await readFile(filePath);
    expect(stillOnDisk.equals(fileBuffer)).toBe(true);
  });

  it("createPhotoRecord failure (e.g. invalid projectId) leaves no Photo row and never touches the filesystem", async () => {
    const before = await prisma.photo.count();

    await expect(
      createPhotoRecord(prisma, {
        projectId: "does-not-exist",
        filename: "orphan-check.jpg",
        path: "/tmp/does-not-matter.jpg",
        timestamp: new Date("2026-07-09T08:00:00.000Z"),
      }),
    ).rejects.toThrow();

    const after = await prisma.photo.count();
    expect(after).toBe(before);
  });
});
