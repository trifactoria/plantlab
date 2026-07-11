import Link from "next/link";
import { notFound } from "next/navigation";
import { ObservationCard } from "@/components/ObservationCard";
import { dayKey, dayLabel } from "@/lib/gallery";
import { ensurePlantOriginEvents } from "@/lib/experiment";
import { prisma } from "@/lib/prisma";
import { formatDateTimeInZone } from "@/lib/timezone";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ sort?: string }>;
};

type TimelineEntry = {
  id: string;
  kind: string;
  timestamp: Date;
  type: string;
  notes: string | null;
  photoId: string | null;
  milestoneId: string | null;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
  plant: { id: string; name: string };
  photo: { id: string; filename: string } | null;
};

export default async function ProjectTimelinePage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { sort } = await searchParams;
  const newestFirst = sort === "newest";
  await ensurePlantOriginEvents(prisma, projectId);
  const [project, milestones] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        plants: {
          include: {
            events: { include: { photo: true } },
          },
        },
      },
    }),
    prisma.projectMilestone.findMany({
      where: { projectId, enabled: true },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    }),
  ]);

  if (!project) {
    notFound();
  }

  const entries: TimelineEntry[] = project.plants.flatMap((plant) =>
    plant.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      timestamp: event.timestamp,
      type: event.type,
      notes: event.notes,
      photoId: event.photoId,
      milestoneId: event.milestoneId,
      cropX: event.cropX,
      cropY: event.cropY,
      cropWidth: event.cropWidth,
      cropHeight: event.cropHeight,
      plant: { id: plant.id, name: plant.name },
      photo: event.photo ? { id: event.photo.id, filename: event.photo.filename } : null,
    })),
  );

  entries.sort((a, b) =>
    newestFirst
      ? b.timestamp.getTime() - a.timestamp.getTime()
      : a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const grouped = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.timestamp, project.timeZone);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }

  const milestoneOptions = milestones.map((milestone) => ({ id: milestone.id, label: milestone.label }));

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${project.id}`} className="text-sm font-semibold text-emerald-700">
            {project.name}
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-3xl font-semibold text-stone-950">Timeline</h1>
            <div className="flex gap-2">
              <Link className={!newestFirst ? "button" : "button-secondary"} href={`/projects/${project.id}/timeline`}>
                Oldest First
              </Link>
              <Link className={newestFirst ? "button" : "button-secondary"} href={`/projects/${project.id}/timeline?sort=newest`}>
                Newest First
              </Link>
            </div>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6">
          {entries.length === 0 ? (
            <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
              No plants or events are recorded yet.
            </p>
          ) : (
            Array.from(grouped.entries()).map(([key, dayEntries]) => (
              <section key={key} className="grid gap-3">
                <h2 className="text-lg font-semibold text-stone-950">{dayLabel(key, project.timeZone)}</h2>
                {dayEntries.map((entry) => (
                  <ObservationCard
                    key={entry.id}
                    plantId={entry.plant.id}
                    milestones={milestoneOptions}
                    timestampLabel={formatDateTimeInZone(entry.timestamp, project.timeZone)}
                    plantLink={{ href: `/plants/${entry.plant.id}`, label: entry.plant.name }}
                    photoHref={entry.photo ? `/photos/${entry.photo.id}` : undefined}
                    event={{
                      id: entry.id,
                      kind: entry.kind,
                      type: entry.type,
                      notes: entry.notes,
                      timestamp: entry.timestamp.toISOString(),
                      photoId: entry.photoId,
                      milestoneId: entry.milestoneId,
                      cropX: entry.cropX,
                      cropY: entry.cropY,
                      cropWidth: entry.cropWidth,
                      cropHeight: entry.cropHeight,
                    }}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
