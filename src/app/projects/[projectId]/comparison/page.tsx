import Link from "next/link";
import { notFound } from "next/navigation";
import { baselineForPlant, elapsedMs, ensureDefaultProjectMilestones, formatElapsed } from "@/lib/experiment";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ sort?: string }>;
};

export default async function ProjectComparisonPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { sort } = await searchParams;
  await ensureDefaultProjectMilestones(prisma, projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      milestones: {
        where: { enabled: true },
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      },
      plants: {
        include: {
          events: {
            where: { milestoneId: { not: null } },
            include: { milestone: true },
            orderBy: { timestamp: "asc" },
          },
        },
        orderBy: [{ gridY: "asc" }, { gridX: "asc" }],
      },
    },
  });

  if (!project) {
    notFound();
  }

  const rows = project.plants.map((plant) => {
    const baseline = baselineForPlant(project, plant);
    const eventByMilestone = new Map<string, (typeof plant.events)[number]>();
    for (const event of plant.events) {
      if (event.milestoneId && !eventByMilestone.has(event.milestoneId)) {
        eventByMilestone.set(event.milestoneId, event);
      }
    }
    const completed = project.milestones
      .map((milestone, index) => ({ milestone, index, event: eventByMilestone.get(milestone.id) ?? null }))
      .filter((item) => item.event);
    const latestIndex = completed.at(-1)?.index ?? -1;
    const latestElapsed = completed.at(-1)?.event
      ? elapsedMs(baseline.date, completed.at(-1)!.event!.timestamp)
      : Number.POSITIVE_INFINITY;

    return { plant, baseline, eventByMilestone, latestIndex, latestElapsed };
  });

  const sortMilestone = project.milestones.find((milestone) => milestone.key === sort);
  rows.sort((a, b) => {
    if (sortMilestone) {
      const aEvent = a.eventByMilestone.get(sortMilestone.id);
      const bEvent = b.eventByMilestone.get(sortMilestone.id);
      const aElapsed = aEvent ? elapsedMs(a.baseline.date, aEvent.timestamp) : Number.POSITIVE_INFINITY;
      const bElapsed = bEvent ? elapsedMs(b.baseline.date, bEvent.timestamp) : Number.POSITIVE_INFINITY;
      return aElapsed - bElapsed || a.plant.name.localeCompare(b.plant.name);
    }

    return b.latestIndex - a.latestIndex || a.latestElapsed - b.latestElapsed || a.plant.name.localeCompare(b.plant.name);
  });

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${project.id}`} className="text-sm font-semibold text-emerald-700">
            {project.name}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">Comparison</h1>
          <p className="mt-2 text-sm text-stone-600">
            Elapsed times use {project.plantedAt ? "the project planting date" : "each plant's start date"}.
          </p>
        </div>
      </header>

      <section className="section">
        <div className="container overflow-x-auto">
          <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr>
                <th className="border-b border-stone-200 bg-white p-3 font-semibold text-stone-950">Plant</th>
                <th className="border-b border-stone-200 bg-white p-3 font-semibold text-stone-950">Baseline</th>
                {project.milestones.map((milestone) => (
                  <th key={milestone.id} className="border-b border-stone-200 bg-white p-3 font-semibold text-stone-950">
                    <Link
                      href={`/projects/${project.id}/comparison?sort=${milestone.key}`}
                      className={sort === milestone.key ? "text-emerald-700" : "hover:text-emerald-700"}
                    >
                      {milestone.label}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.plant.id}>
                  <td className="border-b border-stone-100 bg-white p-3">
                    <Link href={`/plants/${row.plant.id}`} className="font-semibold text-emerald-700">
                      {row.plant.name}
                    </Link>
                  </td>
                  <td className="border-b border-stone-100 bg-white p-3 text-stone-600">
                    <p>{row.baseline.label}</p>
                    <p className="text-xs">{formatDateTime(row.baseline.date)}</p>
                  </td>
                  {project.milestones.map((milestone) => {
                    const event = row.eventByMilestone.get(milestone.id);
                    return (
                      <td key={milestone.id} className="border-b border-stone-100 bg-white p-3">
                        {event ? (
                          <>
                            <p className="font-medium text-stone-950">{formatElapsed(elapsedMs(row.baseline.date, event.timestamp))}</p>
                            <p className="text-xs text-stone-500">{formatDateTime(event.timestamp)}</p>
                          </>
                        ) : (
                          <span className="text-stone-400">Pending</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
