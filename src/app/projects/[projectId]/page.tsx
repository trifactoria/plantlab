import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CapturePhotoButton } from "@/components/CapturePhotoButton";
import { PlantGrid } from "@/components/PlantGrid";
import { PhotoUploadForm } from "@/components/PhotoUploadForm";
import { ProjectCropStatus } from "@/components/ProjectCropStatus";
import { ProjectEnvironmentPanel } from "@/components/ProjectEnvironmentPanel";
import { ProjectMilestoneSettings } from "@/components/ProjectMilestoneSettings";
import { ProjectSensorBindingsPanel } from "@/components/ProjectSensorBindingsPanel";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";
import { ScanPhotosButton } from "@/components/ScanPhotosButton";
import { AppHeader } from "@/components/shell/AppHeader";
import { ProjectCameraTab, type ProjectCameraSummaryView } from "@/components/project/ProjectCameraTab";
import { ProjectOverviewTab } from "@/components/project/ProjectOverviewTab";
import { ProjectTabs, normalizeProjectTab } from "@/components/project/ProjectTabs";
import { computeProjectCropStatus } from "@/lib/cropVersions";
import {
  ensureDefaultProjectMilestones,
  ensurePlantOriginEvents,
} from "@/lib/experiment";
import { groupPhotosByDay, groupPhotosByMonth } from "@/lib/gallery";
import { canDiscoverLocalCameraHardware } from "@/lib/localOnly";
import { getFleetCamera } from "@/lib/operations/fleetHardware";
import { getProjectCameraSummary } from "@/lib/operations/projectCameraSummary";
import { projectCaptureSummary } from "@/lib/operations/projectCapture";
import { listProjectSensorBindings } from "@/lib/operations/projectSensors";
import { prisma } from "@/lib/prisma";
import { isInsideCaptureWindow, nextPermittedCaptureTime } from "@/lib/schedule";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ tab?: string | string[] }>;
};

export default async function ProjectPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const activeTab = normalizeProjectTab(resolvedSearch.tab);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { plants: { orderBy: [{ gridY: "asc" }, { gridX: "asc" }] } },
  });
  if (!project) notFound();

  await ensureDefaultProjectMilestones(prisma, project.id);
  await ensurePlantOriginEvents(prisma, project.id);

  const nextCaptureAt = nextPermittedCaptureTime({
    startAt: project.captureStartAt,
    intervalMinutes: project.photoIntervalMinutes,
    timeZone: project.timeZone,
    captureWindowEnabled: project.captureWindowEnabled,
    captureWindowStartMinutes: project.captureWindowStartMinutes,
    captureWindowEndMinutes: project.captureWindowEndMinutes,
  });
  const activeViewport = await prisma.projectViewport.findFirst({
    where: { projectId: project.id, active: true, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: "desc" },
  });
  const canCaptureProject = Boolean(activeViewport) || canDiscoverLocalCameraHardware();

  return (
    <main className="min-h-screen bg-stone-50">
      <AppHeader breadcrumb={<Link href="/" className="hover:underline">Projects</Link>} />
      <section className="section">
        <div className="container grid gap-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold text-stone-950">{project.name}</h1>
              {project.isTestProject ? (
                <span className="mt-2 inline-flex rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">Test project</span>
              ) : null}
              {project.description ? <p className="mt-2 max-w-2xl text-stone-600">{project.description}</p> : null}
            </div>
            <ScanPhotosButton projectId={project.id} />
          </div>

          <ProjectTabs projectId={project.id} active={activeTab} />

          <div>
            {activeTab === "overview" ? await renderOverview(project, nextCaptureAt, canCaptureProject) : null}
            {activeTab === "photos" ? await renderPhotos(project, canCaptureProject) : null}
            {activeTab === "camera" ? await renderCamera(project.id) : null}
            {activeTab === "environment" ? await renderEnvironment(project.id, project.timeZone) : null}
            {activeTab === "settings" ? await renderSettings(project.id) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

type BaseProject = NonNullable<Awaited<ReturnType<typeof prisma.project.findUnique>>> & { plants: Array<{ id: string; name: string; gridX: number; gridY: number }> };

async function renderOverview(project: BaseProject, nextCaptureAt: Date | null, canCaptureProject: boolean) {
  const [cameraSummary, bindings, latestPhoto] = await Promise.all([
    getProjectCameraSummary(prisma, project.id),
    listProjectSensorBindings(prisma, project.id),
    prisma.photo.findFirst({ where: { projectId: project.id }, orderBy: { timestamp: "desc" }, select: { id: true, filename: true, timestamp: true } }),
  ]);

  return (
    <ProjectOverviewTab
      project={{
        id: project.id,
        name: project.name,
        description: project.description,
        isTestProject: project.isTestProject,
        gridWidth: project.gridWidth,
        gridHeight: project.gridHeight,
        timeZone: project.timeZone,
        plantedAt: project.plantedAt?.toISOString() ?? null,
        captureEnabled: project.captureEnabled,
      }}
      cameraSummary={cameraSummary as unknown as ProjectCameraSummaryView}
      bindings={bindings}
      latestPhoto={latestPhoto ? { id: latestPhoto.id, filename: latestPhoto.filename, timestamp: latestPhoto.timestamp.toISOString() } : null}
      nextCaptureAt={nextCaptureAt ? nextCaptureAt.toISOString() : null}
      insideWindow={isInsideCaptureWindow(new Date(), project)}
      canCaptureProject={canCaptureProject}
    />
  );
}

async function renderPhotos(project: BaseProject, canCaptureProject: boolean) {
  const [galleryPhotos, cropStatus] = await Promise.all([
    prisma.photo.findMany({ where: { projectId: project.id }, orderBy: { timestamp: "desc" }, select: { id: true, timestamp: true } }),
    computeProjectCropStatus(prisma, project.id),
  ]);
  const milestones = await prisma.projectMilestone.findMany({ where: { projectId: project.id, enabled: true }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] });
  const monthCards = groupPhotosByMonth(galleryPhotos, project.timeZone);
  const dayCards = monthCards.length === 1 ? groupPhotosByDay(galleryPhotos, project.timeZone) : [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {canCaptureProject && !project.isTestProject ? <CapturePhotoButton projectId={project.id} /> : null}
        <Link href={`/projects/${project.id}/timeline`} className="text-sm font-semibold text-emerald-700 hover:underline">
          Timeline &rarr;
        </Link>
        <Link href={`/projects/${project.id}/comparison`} className="text-sm font-semibold text-emerald-700 hover:underline">
          Comparison &rarr;
        </Link>
      </div>

      <div>
        <h2 className="text-xl font-semibold text-stone-950">Grid</h2>
        <div className="mt-4">
          <PlantGrid
            project={{ id: project.id, gridWidth: project.gridWidth, gridHeight: project.gridHeight }}
            plants={project.plants.map((plant) => ({ id: plant.id, name: plant.name, gridX: plant.gridX, gridY: plant.gridY }))}
            milestones={milestones.map((milestone) => ({ id: milestone.id, label: milestone.label }))}
          />
        </div>
      </div>

      <ProjectCropStatus projectId={project.id} status={cropStatus} />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <h2 className="text-xl font-semibold text-stone-950">Photos</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {galleryPhotos.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600 sm:col-span-2 lg:col-span-3">
                Add image files to the photo directory, then scan it.
              </p>
            ) : monthCards.length > 1 ? (
              monthCards.map((month) => (
                <Link key={month.key} href={`/projects/${project.id}/gallery/${month.key}`} className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                    <Image src={`/api/photos/${month.representativePhoto.id}/file`} alt={month.label} fill sizes="(max-width: 1024px) 50vw, 260px" className="object-cover" />
                  </div>
                  <p className="mt-2 text-sm font-semibold text-stone-950">{month.label}</p>
                  <p className="text-xs text-stone-500">{month.dayCount} day{month.dayCount === 1 ? "" : "s"} / {month.photoCount} photo{month.photoCount === 1 ? "" : "s"}</p>
                </Link>
              ))
            ) : (
              dayCards.map((day) => (
                <Link key={day.key} href={`/projects/${project.id}/gallery/${day.key.slice(0, 7)}/${day.key.slice(8, 10)}`} className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                    <Image src={`/api/photos/${day.representativePhoto.id}/file`} alt={day.label} fill sizes="(max-width: 1024px) 50vw, 260px" className="object-cover" />
                  </div>
                  <p className="mt-2 text-sm font-semibold text-stone-950">{day.label}</p>
                </Link>
              ))
            )}
          </div>
        </div>
        <PhotoUploadForm projectId={project.id} />
      </div>
    </div>
  );
}

async function renderCamera(projectId: string) {
  const summary = await getProjectCameraSummary(prisma, projectId);
  if (!summary) notFound();

  // Resolve the canonical fleet camera + source config + outlets for the
  // Configure modal (node-backed cameras only).
  const viewport = await prisma.projectViewport.findFirst({
    where: { projectId, active: true },
    orderBy: { effectiveFrom: "desc" },
    include: {
      captureSource: { include: { assignments: { where: { active: true }, include: { node: true }, orderBy: { updatedAt: "desc" }, take: 1 } } },
    },
  });
  const source = viewport?.captureSource ?? null;
  const assignment = source?.assignments[0] ?? null;
  const fleetCamera = assignment ? await getFleetCamera(prisma, assignment.nodeCameraId) : null;
  const outlets = assignment
    ? await prisma.nodeOutlet.findMany({ where: { nodeId: assignment.nodeId }, select: { id: true, key: true, name: true }, orderBy: { key: "asc" } })
    : [];
  const sourceConfig = source
    ? {
        captureSourceId: source.id,
        scheduleEnabled: source.active,
        intervalMinutes: source.photoIntervalMinutes,
        timeZone: source.timeZone,
        windowEnabled: source.captureWindowEnabled,
        windowStartMinutes: source.captureWindowStartMinutes,
        windowEndMinutes: source.captureWindowEndMinutes,
        illuminationOutletId: source.illuminationOutletId,
        illuminationPolicy: source.illuminationPolicy === "only-while-on" ? ("only-while-on" as const) : ("unrestricted" as const),
      }
    : null;

  return (
    <ProjectCameraTab
      summary={summary as unknown as ProjectCameraSummaryView}
      fleetCamera={fleetCamera}
      sourceConfig={sourceConfig}
      outlets={outlets}
      shelfLayoutUrl={source ? `/capture-sources/${source.id}` : null}
      settingsHref={`/projects/${projectId}?tab=settings`}
    />
  );
}

async function renderEnvironment(projectId: string, timeZone: string) {
  const bindings = await listProjectSensorBindings(prisma, projectId);
  return (
    <div>
      <h2 className="text-xl font-semibold text-stone-950">Environment</h2>
      <div className="mt-4">
        <ProjectEnvironmentPanel projectId={projectId} timeZone={timeZone} bindings={bindings} />
      </div>
    </div>
  );
}

async function renderSettings(projectId: string) {
  const [project, capture, sensorBindings] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, include: { milestones: { orderBy: [{ sortOrder: "asc" }, { label: "asc" }] } } }),
    projectCaptureSummary(prisma, projectId),
    listProjectSensorBindings(prisma, projectId, { includeDisabled: true }),
  ]);
  if (!project || !capture) notFound();

  return (
    <div className="grid max-w-3xl gap-6">
      <ProjectSettingsForm
        project={{
          id: project.id,
          name: project.name,
          description: project.description,
          gridWidth: project.gridWidth,
          gridHeight: project.gridHeight,
          photoIntervalMinutes: project.photoIntervalMinutes,
          captureStartAt: project.captureStartAt.toISOString(),
          captureEnabled: project.captureEnabled,
          timeZone: project.timeZone,
          captureWindowEnabled: project.captureWindowEnabled,
          captureWindowStartMinutes: project.captureWindowStartMinutes,
          captureWindowEndMinutes: project.captureWindowEndMinutes,
          isTestProject: project.isTestProject,
          plantedAt: project.plantedAt?.toISOString() ?? null,
          localPhotoDirectory: project.localPhotoDirectory,
          cameraDevice: project.cameraDevice,
          cameraName: project.cameraName,
          capture: { mode: capture.mode, captureSourceId: capture.mode === "capture-source" ? capture.captureSourceId : null },
        }}
      />
      <ProjectSensorBindingsPanel projectId={project.id} initialBindings={sensorBindings} />
      <ProjectMilestoneSettings
        projectId={project.id}
        initialMilestones={project.milestones.map((milestone) => ({ id: milestone.id, key: milestone.key, label: milestone.label, sortOrder: milestone.sortOrder, enabled: milestone.enabled }))}
      />
    </div>
  );
}
