import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ObservationCard } from "@/components/ObservationCard";
import { PhotoEditor } from "@/components/PhotoEditor";
import { PlantCropSummary } from "@/components/PlantCropSummary";
import { PlantGrid } from "@/components/PlantGrid";
import { QuickMilestoneEntry } from "@/components/QuickMilestoneEntry";
import { ensureDefaultProjectMilestones, ensurePlantOriginEvents } from "@/lib/experiment";
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

  await ensureDefaultProjectMilestones(prisma, photo.projectId);
  await ensurePlantOriginEvents(prisma, photo.projectId);
  const [plants, photos, events, plantCrops, milestones, milestoneEvents] = await Promise.all([
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
    prisma.projectMilestone.findMany({
      where: { projectId: photo.projectId, enabled: true },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    }),
    prisma.plantEvent.findMany({
      where: { projectId: photo.projectId, milestoneId: { not: null } },
      select: { plantId: true, milestoneId: true },
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
              <div className="mt-4">
                <QuickMilestoneEntry
                  plants={plants.map((plant) => ({ id: plant.id, name: plant.name }))}
                  milestones={milestones.map((milestone) => ({
                    id: milestone.id,
                    key: milestone.key,
                    label: milestone.label,
                  }))}
                  photoId={photo.id}
                  photoTimestamp={photo.timestamp.toISOString()}
                  imageUrl={`/api/photos/${photo.id}/file`}
                  existingMilestones={milestoneEvents}
                  cropByPlantId={Object.fromEntries(
                    plantCrops.map((crop) => [
                      crop.plantId,
                      {
                        cropX: crop.cropX,
                        cropY: crop.cropY,
                        cropWidth: crop.cropWidth,
                        cropHeight: crop.cropHeight,
                      },
                    ]),
                  )}
                />
              </div>
              <div className="mt-4 grid gap-3">
                {events.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                    No events are linked to this photo yet.
                  </p>
                ) : (
                  events.map((event) => (
                    <ObservationCard
                      key={event.id}
                      plantId={event.plant.id}
                      milestones={milestones.map((milestone) => ({ id: milestone.id, label: milestone.label }))}
                      timestampLabel={formatDateTime(event.timestamp)}
                      plantLink={{ href: `/plants/${event.plant.id}`, label: event.plant.name }}
                      event={{
                        id: event.id,
                        kind: event.kind,
                        type: event.type,
                        notes: event.notes,
                        timestamp: event.timestamp.toISOString(),
                        photoId: event.photoId,
                        milestoneId: event.milestoneId,
                        cropX: event.cropX,
                        cropY: event.cropY,
                        cropWidth: event.cropWidth,
                        cropHeight: event.cropHeight,
                      }}
                    />
                  ))
                )}
              </div>
            </div>

            <PlantCropSummary
              photoId={photo.id}
              imageUrl={`/api/photos/${photo.id}/file`}
              plants={plants.map((plant) => ({
                id: plant.id,
                name: plant.name,
                visualAspectRatio: plant.visualAspectRatio as "16:9" | "9:16" | "1:1" | "free" | null,
              }))}
              crops={plantCrops.map((crop) => ({
                id: crop.id,
                plantId: crop.plantId,
                plantName: crop.plant.name,
                updatedAt: crop.updatedAt.toISOString(),
                cropX: crop.cropX,
                cropY: crop.cropY,
                cropWidth: crop.cropWidth,
                cropHeight: crop.cropHeight,
                createdMethod: crop.createdMethod,
                sourceCropId: crop.sourceCropId,
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
                  milestones={milestones.map((milestone) => ({ id: milestone.id, label: milestone.label }))}
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
