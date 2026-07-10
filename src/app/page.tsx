import Link from "next/link";
import { ProjectForm } from "@/components/ProjectForm";
import { ServiceStatusPanel } from "@/components/ServiceStatusPanel";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export default async function HomePage() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { plants: true, photos: true, events: true },
      },
    },
  });
  const canManageLocally =
    process.env.NODE_ENV !== "production" || process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1";

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            PlantLab v0.1
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">
            Local plant experiment tracker
          </h1>
        </div>
      </header>

      {canManageLocally ? (
        <section className="section pb-0">
          <div className="container">
            <ServiceStatusPanel />
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[1fr_420px]">
          <div>
            <h2 className="text-xl font-semibold text-stone-950">Projects</h2>
            <div className="mt-4 grid gap-3">
              {projects.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                  No projects yet. Create one to start tracking photos and plant events.
                </p>
              ) : (
                projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm transition hover:border-emerald-300"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-stone-950">
                          {project.name}
                        </h3>
                        {project.description ? (
                          <p className="mt-1 text-sm text-stone-600">
                            {project.description}
                          </p>
                        ) : null}
                      </div>
                      <span className="rounded-md bg-stone-100 px-2.5 py-1 text-xs font-semibold text-stone-700">
                        {project.gridWidth} x {project.gridHeight}
                      </span>
                    </div>
                    <dl className="mt-4 grid gap-3 text-sm text-stone-600 sm:grid-cols-4">
                      <div>
                        <dt className="font-medium text-stone-950">Photos</dt>
                        <dd>{project._count.photos}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-stone-950">Plants</dt>
                        <dd>{project._count.plants}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-stone-950">Events</dt>
                        <dd>{project._count.events}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-stone-950">Created</dt>
                        <dd>{formatDateTime(project.createdAt)}</dd>
                      </div>
                    </dl>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-stone-950">New Project</h2>
            <div className="mt-4">
              <ProjectForm />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
