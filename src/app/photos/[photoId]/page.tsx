import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventActions } from "@/components/EventActions";
import { PhotoEditor } from "@/components/PhotoEditor";
import { PlantCropSummary } from "@/components/PlantCropSummary";
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

  const [plants, photos, events, plantCrops] = await Promise.all([
    prisma.plant.findMany({
      where: { projectId: photo.projectId },
      orderBy: [{ gridY: "asc" }, { gridX: "asc" }],
    }),
    prisma.photo.findMany({
      where: { projectId: photo.projectId },
      orderBy: { timestamp: "desc" },
      select: { id: true },
    }),
    prisma.plantEvent.findMany({
      where: { photoId: photo.id },
      include: { plant: true },
      orderBy: { timestamp: "desc" },
    }),
    prisma.plantPhotoCrop.findMany({
      where: { photoId: photo.id },
      include: { plant: true },
      orderBy: { createdAt: "asc" },
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
              <h2 className="text-xl font-semibold text-stone-950">Linked Events</h2>
              <div className="mt-4 grid gap-3">
                {events.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                    No events are linked to this photo yet.
                  </p>
                ) : (
                  events.map((event) => (
                    <article
                      key={event.id}
                      className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <Link
                            href={`/plants/${event.plant.id}`}
                            className="text-sm font-semibold text-emerald-700"
                          >
                            {event.plant.name}
                          </Link>
                          <h3 className="mt-1 text-lg font-semibold text-stone-950">
                            {event.type}
                          </h3>
                          <p className="text-sm text-stone-500">
                            {formatDateTime(event.timestamp)}
                          </p>
                        </div>
                        <EventActions
                          event={{
                            id: event.id,
                            type: event.type,
                            notes: event.notes,
                            timestamp: event.timestamp.toISOString(),
                            photoId: event.photoId,
                            cropX: event.cropX,
                            cropY: event.cropY,
                            cropWidth: event.cropWidth,
                            cropHeight: event.cropHeight,
                          }}
                        />
                      </div>
                      {event.notes ? (
                        <p className="mt-3 whitespace-pre-wrap text-sm text-stone-700">
                          {event.notes}
                        </p>
                      ) : null}
                      {event.cropX !== null ? (
                        <div className="mt-3">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/events/${event.id}/crop`}
                            alt={`${event.type} crop`}
                            className="h-28 rounded-md border border-stone-200 object-cover"
                          />
                        </div>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            </div>

            <PlantCropSummary
              photoId={photo.id}
              imageUrl={`/api/photos/${photo.id}/file`}
              plants={plants.map((plant) => ({ id: plant.id, name: plant.name }))}
              crops={plantCrops.map((crop) => ({
                id: crop.id,
                plantId: crop.plantId,
                plantName: crop.plant.name,
                updatedAt: crop.updatedAt.toISOString(),
                cropX: crop.cropX,
                cropY: crop.cropY,
                cropWidth: crop.cropWidth,
                cropHeight: crop.cropHeight,
              }))}
            />

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
            <h2 className="text-lg font-semibold text-stone-950">Edit Photo</h2>
            <div className="mt-4">
              <PhotoEditor
                photoId={photo.id}
                projectId={photo.projectId}
                timestamp={photo.timestamp.toISOString()}
                notes={photo.notes}
              />
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
