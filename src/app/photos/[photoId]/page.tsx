import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PhotoNotesForm } from "@/components/PhotoNotesForm";
import { PlantGrid } from "@/components/PlantGrid";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ photoId: string }>;
};

export default async function PhotoPage({ params }: PageProps) {
  const { photoId } = await params;
  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    include: { project: true },
  });

  if (!photo) {
    notFound();
  }

  const [plants, photos] = await Promise.all([
    prisma.plant.findMany({
      where: { projectId: photo.projectId },
      orderBy: [{ gridY: "asc" }, { gridX: "asc" }],
    }),
    prisma.photo.findMany({
      where: { projectId: photo.projectId },
      orderBy: { timestamp: "desc" },
      select: { id: true },
    }),
  ]);

  const index = photos.findIndex((item) => item.id === photo.id);
  const newerPhoto = index > 0 ? photos[index - 1] : null;
  const olderPhoto = index >= 0 && index < photos.length - 1 ? photos[index + 1] : null;

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${photo.projectId}`} className="text-sm font-semibold text-emerald-700">
            {photo.project.name}
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-stone-950">{photo.filename}</h1>
              <p className="mt-1 text-stone-600">{formatDateTime(photo.timestamp)}</p>
            </div>
            <div className="flex gap-2">
              {olderPhoto ? (
                <Link className="button-secondary" href={`/photos/${olderPhoto.id}`}>
                  Previous
                </Link>
              ) : null}
              {newerPhoto ? (
                <Link className="button-secondary" href={`/photos/${newerPhoto.id}`}>
                  Next
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="grid gap-6">
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-stone-200 bg-black shadow-sm">
              <Image
                src={`/api/photos/${photo.id}/file`}
                alt={photo.filename}
                fill
                sizes="(max-width: 1024px) 100vw, 760px"
                className="object-contain"
                priority
              />
            </div>

            <div>
              <h2 className="text-xl font-semibold text-stone-950">Grid</h2>
              <div className="mt-4">
                <PlantGrid
                  mode="photo"
                  project={{
                    id: photo.projectId,
                    gridWidth: photo.project.gridWidth,
                    gridHeight: photo.project.gridHeight,
                  }}
                  plants={plants.map((plant) => ({
                    id: plant.id,
                    name: plant.name,
                    gridX: plant.gridX,
                    gridY: plant.gridY,
                  }))}
                  photoId={photo.id}
                  photoTimestamp={photo.timestamp.toISOString()}
                />
              </div>
            </div>
          </div>

          <aside className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-stone-950">Photo Notes</h2>
            <div className="mt-4">
              <PhotoNotesForm photoId={photo.id} notes={photo.notes} />
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
