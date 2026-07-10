import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CapturePhotoButton } from "@/components/CapturePhotoButton";
import { PlantGrid } from "@/components/PlantGrid";
import { ScanPhotosButton } from "@/components/ScanPhotosButton";
import { formatDateTime } from "@/lib/format";
import { groupPhotosByDay, groupPhotosByMonth } from "@/lib/gallery";
import { prisma } from "@/lib/prisma";
import { nextAlignedCaptureTime } from "@/lib/schedule";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      plants: { orderBy: [{ gridY: "asc" }, { gridX: "asc" }] },
    },
  });

  if (!project) {
    notFound();
  }

  const [latestPhoto, galleryPhotos] = await Promise.all([
    prisma.photo.findFirst({
      where: { projectId: project.id },
      orderBy: { timestamp: "desc" },
    }),
    prisma.photo.findMany({
      where: { projectId: project.id },
      orderBy: { timestamp: "desc" },
      select: { id: true, timestamp: true },
    }),
  ]);
  const monthCards = groupPhotosByMonth(galleryPhotos);
  const dayCards = monthCards.length === 1 ? groupPhotosByDay(galleryPhotos) : [];
  const canCaptureLocally = process.env.NODE_ENV !== "production";
  const nextCaptureAt = nextAlignedCaptureTime({
    startAt: project.captureStartAt,
    intervalMinutes: project.photoIntervalMinutes,
  });
  const gridPlants = project.plants.map((plant) => ({
    id: plant.id,
    name: plant.name,
    gridX: plant.gridX,
    gridY: plant.gridY,
  }));

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href="/" className="text-sm font-semibold text-emerald-700">
            PlantLab
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold text-stone-950">{project.name}</h1>
              {project.description ? (
                <p className="mt-2 max-w-2xl text-stone-600">{project.description}</p>
              ) : null}
              <Link
                href={`/projects/${project.id}/settings`}
                className="mt-3 inline-flex text-sm font-semibold text-emerald-700 hover:text-emerald-900"
              >
                Project Settings
              </Link>
              <span className="mx-2 text-stone-300">/</span>
              <Link
                href={`/projects/${project.id}/camera`}
                className="inline-flex text-sm font-semibold text-emerald-700 hover:text-emerald-900"
              >
                Camera Setup
              </Link>
            </div>
            <div className="grid gap-2 sm:justify-items-end">
              {canCaptureLocally ? (
                <CapturePhotoButton projectId={project.id} />
              ) : null}
              <ScanPhotosButton projectId={project.id} />
            </div>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="grid content-start gap-4">
            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Project Information</h2>
              <dl className="mt-4 grid gap-3 text-sm">
                <div>
                  <dt className="font-medium text-stone-950">Grid</dt>
                  <dd className="text-stone-600">
                    {project.gridWidth} columns x {project.gridHeight} rows
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Photo interval</dt>
                  <dd className="text-stone-600">
                    {project.photoIntervalMinutes} minutes
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Camera</dt>
                  <dd className="text-stone-600">
                    {project.cameraDevice
                      ? `${project.cameraName ?? "Camera"} (${project.cameraDevice})`
                      : "No camera selected"}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Schedule start</dt>
                  <dd className="text-stone-600">{formatDateTime(project.captureStartAt)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Next capture</dt>
                  <dd className="text-stone-600">{formatDateTime(nextCaptureAt)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Watcher command</dt>
                  <dd className="break-all font-mono text-xs text-stone-600">
                    pnpm camera:watch -- {project.id}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Photo directory</dt>
                  <dd className="break-all font-mono text-xs text-stone-600">
                    {project.localPhotoDirectory}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Latest Photo</h2>
              {latestPhoto ? (
                <Link href={`/photos/${latestPhoto.id}`} className="mt-4 block">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                    <Image
                      src={`/api/photos/${latestPhoto.id}/file`}
                      alt={latestPhoto.filename}
                      fill
                      sizes="360px"
                      className="object-contain"
                      priority
                    />
                  </div>
                  <p className="mt-2 text-sm font-medium text-stone-950">
                    {latestPhoto.filename}
                  </p>
                  <p className="text-sm text-stone-500">
                    {formatDateTime(latestPhoto.timestamp)}
                  </p>
                </Link>
              ) : (
                <p className="mt-3 text-sm text-stone-600">
                  No photos imported yet.
                </p>
              )}
            </div>
          </aside>

          <div className="grid gap-6">
            <div>
              <h2 className="text-xl font-semibold text-stone-950">Grid</h2>
              <div className="mt-4">
                <PlantGrid
                  project={{
                    id: project.id,
                    gridWidth: project.gridWidth,
                    gridHeight: project.gridHeight,
                  }}
                  plants={gridPlants}
                />
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold text-stone-950">Photo Gallery</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {galleryPhotos.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600 sm:col-span-2 lg:col-span-3">
                    Add image files to the photo directory, then scan it.
                  </p>
                ) : monthCards.length > 1 ? (
                  monthCards.map((month) => (
                    <Link
                      key={month.key}
                      href={`/projects/${project.id}/gallery/${month.key}`}
                      className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                        <Image
                          src={`/api/photos/${month.representativePhoto.id}/file`}
                          alt={month.label}
                          fill
                          sizes="(max-width: 1024px) 50vw, 260px"
                          className="object-cover"
                        />
                      </div>
                      <p className="mt-2 text-sm font-semibold text-stone-950">
                        {month.label}
                      </p>
                      <p className="text-xs text-stone-500">
                        {month.dayCount} day{month.dayCount === 1 ? "" : "s"} / {month.photoCount} photo{month.photoCount === 1 ? "" : "s"}
                      </p>
                    </Link>
                  ))
                ) : (
                  dayCards.map((day) => (
                    <Link
                      key={day.key}
                      href={`/projects/${project.id}/gallery/${day.key.slice(0, 7)}/${day.key.slice(8, 10)}`}
                      className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                        <Image
                          src={`/api/photos/${day.representativePhoto.id}/file`}
                          alt={day.label}
                          fill
                          sizes="(max-width: 1024px) 50vw, 260px"
                          className="object-cover"
                        />
                      </div>
                      <p className="mt-2 text-sm font-semibold text-stone-950">
                        {day.label}
                      </p>
                      <p className="text-xs text-stone-500">
                        {day.photoCount} photo{day.photoCount === 1 ? "" : "s"} / {formatDateTime(day.firstCaptureAt)} - {formatDateTime(day.lastCaptureAt)}
                      </p>
                    </Link>
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
