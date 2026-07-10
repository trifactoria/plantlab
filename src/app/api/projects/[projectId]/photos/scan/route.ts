import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { isImageFile, parsePhotoTimestampFromFilename } from "@/lib/photos";
import { prisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { projectId } = await context.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const entries = await readdir(project.localPhotoDirectory, {
      withFileTypes: true,
    });
    let imported = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !isImageFile(entry.name)) {
        continue;
      }

      const photoPath = path.resolve(project.localPhotoDirectory, entry.name);
      const existing = await prisma.photo.findUnique({
        where: {
          projectId_path: {
            projectId,
            path: photoPath,
          },
        },
      });

      if (existing) {
        continue;
      }

      const fileStat = await stat(photoPath);
      await prisma.photo.create({
        data: {
          projectId,
          filename: entry.name,
          path: photoPath,
          timestamp: parsePhotoTimestampFromFilename(entry.name) ?? fileStat.mtime,
        },
      });
      imported += 1;
    }

    return NextResponse.json({ imported });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Could not scan the project photo directory" },
      { status: 400 },
    );
  }
}
