import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectSettingsPage({ params }: PageProps) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) {
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
              localPhotoDirectory: project.localPhotoDirectory,
              cameraDevice: project.cameraDevice,
              cameraName: project.cameraName,
            }}
          />
        </div>
      </section>
    </main>
  );
}
