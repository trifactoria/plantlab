import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import * as exifr from "exifr";
import { badRequest, notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SUPPORTED_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

function safeStem(filename: string) {
  const parsed = path.parse(filename).name;
  const stem = parsed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return stem || "photo";
}

function dateFromLastModified(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function timestampFromImage(buffer: Buffer, fallbackLastModified: Date | null) {
  try {
    const metadata = await exifr.parse(buffer, ["DateTimeOriginal", "CreateDate"]);
    const exifDate = metadata?.DateTimeOriginal ?? metadata?.CreateDate;

    if (exifDate instanceof Date && !Number.isNaN(exifDate.getTime())) {
      return { timestamp: exifDate, source: "EXIF" };
    }
  } catch {
    // Unsupported or malformed metadata should not block a valid image upload.
  }

  if (fallbackLastModified) {
    return { timestamp: fallbackLastModified, source: "file date" };
  }

  return { timestamp: new Date(), source: "current time" };
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return notFound("Project not found");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Upload must be multipart form data.");
  }

  const files = formData.getAll("files").filter((file): file is File => file instanceof File);

  if (files.length === 0) {
    return badRequest("Select at least one image file.");
  }

  await mkdir(project.localPhotoDirectory, { recursive: true });

  const results = [];
  for (const [index, file] of files.entries()) {
    const lastModified = dateFromLastModified(formData.get(`lastModified-${index}`));

    try {
      const extension = SUPPORTED_TYPES.get(file.type);
      if (!extension) {
        results.push({
          filename: file.name,
          success: false,
          error: "Unsupported image format. Use JPEG, PNG, or WebP.",
        });
        continue;
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        results.push({
          filename: file.name,
          success: false,
          error: "Image is too large. Maximum size is 20 MB.",
        });
        continue;
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const { timestamp, source } = await timestampFromImage(buffer, lastModified);
      const filename = `${safeStem(file.name)}-${randomUUID()}${extension}`;
      const savedPath = path.join(project.localPhotoDirectory, filename);

      await writeFile(savedPath, buffer);

      try {
        const photo = await prisma.photo.create({
          data: {
            projectId: project.id,
            filename,
            path: savedPath,
            timestamp,
          },
        });

        results.push({
          filename: file.name,
          savedFilename: filename,
          photoId: photo.id,
          chosenTimestamp: timestamp.toISOString(),
          timestampSource: source,
          success: true,
        });
      } catch (error) {
        await unlink(savedPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      console.error(error);
      results.push({
        filename: file.name,
        success: false,
        error: error instanceof Error ? error.message : "Could not import image.",
      });
    }
  }

  return NextResponse.json({ results });
}
