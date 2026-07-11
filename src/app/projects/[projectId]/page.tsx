import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CapturePhotoButton } from "@/components/CapturePhotoButton";
import { PlantGrid } from "@/components/PlantGrid";
import { PhotoUploadForm } from "@/components/PhotoUploadForm";
import { ScanPhotosButton } from "@/components/ScanPhotosButton";
import { formatDateTime } from "@/lib/format";
import {
  FIRST_TRUE_LEAF_MILESTONE_KEY,
  FIRST_VISIBLE_MILESTONE_KEY,
  HARVEST_READY_MILESTONE_KEY,
  HARVESTED_MILESTONE_KEY,
  ensureDefaultProjectMilestones,
  formatElapsed,
  baselineForPlant,
  elapsedMs,
} from "@/lib/experiment";
import { groupPhotosByDay, groupPhotosByMonth } from "@/lib/gallery";
import { prisma } from "@/lib/prisma";
import { captureWindowLabel, isInsideCaptureWindow, nextPermittedCaptureTime } from "@/lib/schedule";
import { formatDateTimeInZone } from "@/lib/timezone";

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
  const projectRecord = project;

  await ensureDefaultProjectMilestones(prisma, projectRecord.id);
  const [latestPhoto, galleryPhotos, milestones, canonicalEvents, harvestResults] = await Promise.all([
    prisma.photo.findFirst({
      where: { projectId: projectRecord.id },
      orderBy: { timestamp: "desc" },
    }),
    prisma.photo.findMany({
      where: { projectId: projectRecord.id },
      orderBy: { timestamp: "desc" },
      select: { id: true, timestamp: true },
    }),
    prisma.projectMilestone.findMany({ where: { projectId: projectRecord.id } }),
    prisma.plantEvent.findMany({
      where: { projectId: projectRecord.id, milestoneId: { not: null } },
      include: { plant: true, milestone: true },
      orderBy: { timestamp: "asc" },
    }),
    prisma.plantHarvestResult.findMany({ where: { plant: { projectId: projectRecord.id } } }),
  ]);
  const monthCards = groupPhotosByMonth(galleryPhotos, projectRecord.timeZone);
  const dayCards = monthCards.length === 1 ? groupPhotosByDay(galleryPhotos, projectRecord.timeZone) : [];
  const canCaptureLocally = process.env.NODE_ENV !== "production";
  const nextCaptureAt = nextPermittedCaptureTime({
    startAt: projectRecord.captureStartAt,
    intervalMinutes: projectRecord.photoIntervalMinutes,
    timeZone: projectRecord.timeZone,
    captureWindowEnabled: projectRecord.captureWindowEnabled,
    captureWindowStartMinutes: projectRecord.captureWindowStartMinutes,
    captureWindowEndMinutes: projectRecord.captureWindowEndMinutes,
  });
  const insideWindow = isInsideCaptureWindow(new Date(), projectRecord);
  const gridPlants = projectRecord.plants.map((plant) => ({
    id: plant.id,
    name: plant.name,
    gridX: plant.gridX,
    gridY: plant.gridY,
  }));
  const milestoneByKey = new Map(milestones.map((milestone) => [milestone.key, milestone]));
  const gridMilestones = milestones
    .filter((milestone) => milestone.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map((milestone) => ({ id: milestone.id, label: milestone.label }));
  function fastestFor(key: string) {
    const milestone = milestoneByKey.get(key);
    if (!milestone) {
      return null;
    }
    return canonicalEvents
      .filter((event) => event.milestoneId === milestone.id)
      .map((event) => {
        const plant = projectRecord.plants.find((item) => item.id === event.plantId);
        if (!plant) {
          return null;
        }
        const baseline = baselineForPlant(projectRecord, plant);
        return { event, elapsed: elapsedMs(baseline.date, event.timestamp) };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.elapsed - b.elapsed)[0] ?? null;
  }
  const firstVisible = fastestFor(FIRST_VISIBLE_MILESTONE_KEY);
  const firstTrueLeaf = fastestFor(FIRST_TRUE_LEAF_MILESTONE_KEY);
  const harvestReady = fastestFor(HARVEST_READY_MILESTONE_KEY);
  const harvested = fastestFor(HARVESTED_MILESTONE_KEY);
  const summaryItems: Array<[string, ReturnType<typeof fastestFor>]> = [
    ["Fastest first visible", firstVisible],
    ["Fastest first true leaf", firstTrueLeaf],
    ["First harvest-ready plant", harvestReady],
    ["First harvested plant", harvested],
  ];

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
              {project.isTestProject ? (
                <span className="mt-2 inline-flex rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">
                  Test project
                </span>
              ) : null}
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
              <span className="mx-2 text-stone-300">/</span>
              <Link
                href={`/projects/${project.id}/timeline`}
                className="inline-flex text-sm font-semibold text-emerald-700 hover:text-emerald-900"
              >
                Timeline
              </Link>
              <span className="mx-2 text-stone-300">/</span>
              <Link
                href={`/projects/${project.id}/comparison`}
                className="inline-flex text-sm font-semibold text-emerald-700 hover:text-emerald-900"
              >
                Comparison
              </Link>
            </div>
            <div className="grid gap-2 sm:justify-items-end">
              {canCaptureLocally && !project.isTestProject ? (
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
                  <dt className="font-medium text-stone-950">Timezone</dt>
                  <dd className="text-stone-600">{project.timeZone}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Capture hours</dt>
                  <dd className="text-stone-600">{captureWindowLabel(project)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Window status</dt>
                  <dd className={insideWindow ? "text-emerald-700" : "text-amber-700"}>
                    {insideWindow ? "Inside capture window" : "Outside capture window"}
                  </dd>
                </div>
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
                  <dt className="font-medium text-stone-950">Planted</dt>
                  <dd className="text-stone-600">
                    {project.plantedAt ? formatDateTime(project.plantedAt) : "Unknown"}
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
                  <dt className="font-medium text-stone-950">Scheduled capture</dt>
                  <dd className="text-stone-600">{project.captureEnabled ? "Enabled" : "Disabled"}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Schedule start</dt>
                  <dd className="text-stone-600">{formatDateTimeInZone(project.captureStartAt, project.timeZone)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Next capture</dt>
                  <dd className="text-stone-600">
                    {nextCaptureAt ? formatDateTimeInZone(nextCaptureAt, project.timeZone) : "None found"}
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
                    {formatDateTimeInZone(latestPhoto.timestamp, project.timeZone)}
                  </p>
                </Link>
              ) : (
                <p className="mt-3 text-sm text-stone-600">
                  No photos imported yet.
                </p>
              )}
            </div>

            <PhotoUploadForm projectId={project.id} />
          </aside>

          <div className="grid gap-6">
            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-semibold text-stone-950">Experiment Summary</h2>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {summaryItems.map(([label, result]) => (
                  <div key={label}>
                    <dt className="font-medium text-stone-950">{label}</dt>
                    <dd className="text-stone-600">
                      {result ? (
                        <>
                          <Link href={`/plants/${result.event.plantId}`} className="font-semibold text-emerald-700">
                            {result.event.plant.name}
                          </Link>{" "}
                          {formatElapsed(result.elapsed)}
                        </>
                      ) : (
                        "Pending"
                      )}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt className="font-medium text-stone-950">Active plants</dt>
                  <dd className="text-stone-600">{project.plants.length - harvestResults.length}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Harvested</dt>
                  <dd className="text-stone-600">{harvestResults.length}</dd>
                </div>
              </dl>
            </div>

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
                  milestones={gridMilestones}
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
                        {day.photoCount} photo{day.photoCount === 1 ? "" : "s"} / {formatDateTimeInZone(day.firstCaptureAt, project.timeZone)} - {formatDateTimeInZone(day.lastCaptureAt, project.timeZone)}
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
