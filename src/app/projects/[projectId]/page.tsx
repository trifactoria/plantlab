import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CapturePhotoButton } from "@/components/CapturePhotoButton";
import { PlantGrid } from "@/components/PlantGrid";
import { ScanPhotosButton } from "@/components/ScanPhotosButton";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      plants: { orderBy: [{ gridY: "asc" }, { gridX: "asc" }] },
      photos: { orderBy: { timestamp: "desc" } },
    },
  });

  if (!project) {
    notFound();
  }

  const latestPhoto = project.photos[0] ?? null;
  const canCaptureLocally = process.env.NODE_ENV !== "production";
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
                {project.photos.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600 sm:col-span-2 lg:col-span-3">
                    Add image files to the photo directory, then scan it.
                  </p>
                ) : (
                  project.photos.map((photo) => (
                    <Link
                      key={photo.id}
                      href={`/photos/${photo.id}`}
                      className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                        <Image
                          src={`/api/photos/${photo.id}/file`}
                          alt={photo.filename}
                          fill
                          sizes="(max-width: 1024px) 50vw, 260px"
                          className="object-cover"
                        />
                      </div>
                      <p className="mt-2 truncate text-sm font-medium text-stone-950">
                        {photo.filename}
                      </p>
                      <p className="text-xs text-stone-500">
                        {formatDateTime(photo.timestamp)}
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
