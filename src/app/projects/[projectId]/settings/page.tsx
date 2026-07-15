import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectMilestoneSettings } from "@/components/ProjectMilestoneSettings";
import { ensureDefaultProjectMilestones } from "@/lib/experiment";
import { projectCaptureSummary } from "@/lib/operations/projectCapture";
import { listProjectSensorBindings } from "@/lib/operations/projectSensors";
import { ProjectSensorBindingsPanel } from "@/components/ProjectSensorBindingsPanel";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectSettingsPage({ params }: PageProps) {
  const { projectId } = await params;
  await ensureDefaultProjectMilestones(prisma, projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { milestones: { orderBy: [{ sortOrder: "asc" }, { label: "asc" }] } },
  });

  if (!project) {
    notFound();
  }

  const [capture, sensorBindings] = await Promise.all([
    projectCaptureSummary(prisma, project.id),
    listProjectSensorBindings(prisma, project.id, { includeDisabled: true }),
  ]);
  if (!capture) {
    notFound();
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${project.id}`} className="text-sm font-semibold text-emerald-700">
            {project.name}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">Project Settings</h1>
        </div>
      </header>

      <section className="section">
        <div className="container max-w-3xl">
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
          <div className="mt-6">
            <ProjectSensorBindingsPanel projectId={project.id} initialBindings={sensorBindings} />
          </div>
          <div className="mt-6">
            <ProjectMilestoneSettings
              projectId={project.id}
              initialMilestones={project.milestones.map((milestone) => ({
                id: milestone.id,
                key: milestone.key,
                label: milestone.label,
                sortOrder: milestone.sortOrder,
                enabled: milestone.enabled,
              }))}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
