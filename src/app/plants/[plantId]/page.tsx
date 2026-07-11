import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventActions } from "@/components/EventActions";
import { PlantEditor } from "@/components/PlantEditor";
import { PlantVisualHistory } from "@/components/PlantVisualHistory";
import { buildCropThumbnailUrl } from "@/lib/cropThumbnail";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

const VISUAL_HISTORY_PAGE_SIZE = 300;

type PageProps = {
  params: Promise<{ plantId: string }>;
};

export default async function PlantPage({ params }: PageProps) {
  const { plantId } = await params;
  const plant = await prisma.plant.findUnique({
    where: { id: plantId },
    include: {
      project: true,
      events: {
        include: { photo: true },
        orderBy: { timestamp: "asc" },
      },
    },
  });

  if (!plant) {
    notFound();
  }

  const linkedPhotos = Array.from(
    new Map(
      plant.events
        .filter((event) => event.photo)
        .map((event) => [event.photo!.id, event.photo!]),
    ).values(),
  ).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const [visualHistoryTotalCount, visualHistoryPage, latestProjectPhoto, linkedPhotoCrops] =
    await Promise.all([
      prisma.plantPhotoCrop.count({ where: { plantId } }),
      prisma.plantPhotoCrop.findMany({
        where: { plantId },
        orderBy: [{ photo: { timestamp: "asc" } }, { photoId: "asc" }],
        take: VISUAL_HISTORY_PAGE_SIZE,
        select: { photoId: true, photo: { select: { timestamp: true } } },
      }),
      prisma.photo.findFirst({
        where: { projectId: plant.projectId },
        orderBy: { timestamp: "desc" },
        select: { id: true },
      }),
      prisma.plantPhotoCrop.findMany({
        where: { plantId, photoId: { in: linkedPhotos.map((photo) => photo.id) } },
        select: { id: true, photoId: true, updatedAt: true },
      }),
    ]);

  const visualHistoryFrames = visualHistoryPage.map((crop) => ({
    photoId: crop.photoId,
    timestamp: crop.photo.timestamp.toISOString(),
  }));
  const linkedPhotoCropByPhotoId = new Map(linkedPhotoCrops.map((crop) => [crop.photoId, crop]));

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${plant.projectId}`} className="text-sm font-semibold text-emerald-700">
            {plant.project.name}
          </Link>
          <div className="mt-3">
            <h1 className="text-3xl font-semibold text-stone-950">{plant.name}</h1>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="grid content-start gap-4">
            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Edit Plant</h2>
              <div className="mt-4">
                <PlantEditor
                  plantId={plant.id}
                  projectId={plant.projectId}
                  name={plant.name}
                  tags={plant.tags}
                  notes={plant.notes}
                  startLabel={plant.startLabel}
                  startedAt={plant.startedAt.toISOString()}
                  eventCount={plant.events.length}
                />
              </div>
            </div>

            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Linked Photos</h2>
              <div className="mt-4 grid gap-3">
                {linkedPhotos.length === 0 ? (
                  <p className="text-sm text-stone-600">No linked photos yet.</p>
                ) : (
                  linkedPhotos.map((photo) => {
                    const crop = linkedPhotoCropByPhotoId.get(photo.id);
                    return (
                      <Link key={photo.id} href={`/photos/${photo.id}`} className="block">
                        <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                          <Image
                            src={crop ? buildCropThumbnailUrl(crop, { size: 320 }) : `/api/photos/${photo.id}/file`}
                            alt={photo.filename}
                            fill
                            sizes="320px"
                            className="object-cover"
                          />
                        </div>
                        <p className="mt-1 truncate text-sm font-medium text-stone-950">
                          {photo.filename}
                        </p>
                      </Link>
                    );
                  })
                )}
              </div>
            </div>
          </aside>

          <div className="grid gap-8">
            <div>
              <h2 className="text-xl font-semibold text-stone-950">Visual History</h2>
              <div className="mt-4">
                <PlantVisualHistory
                  plantId={plant.id}
                  projectId={plant.projectId}
                  latestPhotoId={latestProjectPhoto?.id ?? null}
                  initialFrames={visualHistoryFrames}
                  initialTotalCount={visualHistoryTotalCount}
                  initialHasMore={visualHistoryTotalCount > visualHistoryFrames.length}
                />
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold text-stone-950">Timeline</h2>
            <div className="mt-4 grid gap-3">
              <article className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase text-emerald-800">Starting entry</p>
                <h3 className="mt-1 text-lg font-semibold text-stone-950">
                  {plant.startLabel}
                </h3>
                <p className="text-sm text-stone-600">{formatDateTime(plant.startedAt)}</p>
              </article>

              {plant.events.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                  No later events recorded yet.
                </p>
              ) : (
                plant.events.map((event) => (
                  <article
                    key={event.id}
                    className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-stone-950">
                          {event.type}
                        </h3>
                        <p className="text-sm text-stone-500">
                          {formatDateTime(event.timestamp)}
                        </p>
                      </div>
                      <div className="grid gap-2 justify-items-start sm:justify-items-end">
                        {event.photo ? (
                          <Link className="button-secondary" href={`/photos/${event.photo.id}`}>
                            Open Photo
                          </Link>
                        ) : null}
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
                    </div>
                    {event.notes ? (
                      <p className="mt-3 whitespace-pre-wrap text-sm text-stone-700">
                        {event.notes}
                      </p>
                    ) : null}
                    {event.photoId && event.cropX !== null ? (
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
          </div>
        </div>
      </section>
    </main>
  );
}
