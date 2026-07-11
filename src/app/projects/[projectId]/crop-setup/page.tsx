import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectCropSetupWizard } from "@/components/ProjectCropSetupWizard";
import { loadProjectCropSetupData } from "@/lib/cropVersions";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ photoId?: string; filter?: string }>;
};

export default async function ProjectCropSetupPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { photoId, filter } = await searchParams;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    notFound();
  }

  const photos = await prisma.photo.findMany({
    where: { projectId },
    orderBy: { timestamp: "desc" },
    select: { id: true, filename: true, timestamp: true },
  });

  const setupData =
    (await loadProjectCropSetupData(prisma, projectId, photoId ?? null)) ??
    (photos.length > 0 ? await loadProjectCropSetupData(prisma, projectId, null) : null);

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${projectId}`} className="text-sm font-semibold text-emerald-700">
            {project.name}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">Configure Project Crops</h1>
          <p className="mt-1 text-sm text-stone-600">
            Move a ready-made crop box from plant to plant on one representative photo instead of visiting
            each plant page.
          </p>
        </div>
      </header>

      <section className="section">
        <div className="container">
          {!setupData ? (
            <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
              This project has no photos yet. Capture, upload, or scan at least one photo before configuring
              crops.
            </p>
          ) : (
            <ProjectCropSetupWizard
              projectId={projectId}
              photos={photos.map((photo) => ({
                id: photo.id,
                filename: photo.filename,
                timestamp: photo.timestamp.toISOString(),
              }))}
              initialData={setupData}
              initialFilter={filter === "unconfigured" ? "unconfigured" : "all"}
            />
          )}
        </div>
      </section>
    </main>
  );
}
