import Link from "next/link";
import { notFound } from "next/navigation";
import { EventActions } from "@/components/EventActions";
import { dayKey, dayLabel } from "@/lib/gallery";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ sort?: string }>;
};

type TimelineEntry =
  | {
      kind: "start";
      id: string;
      timestamp: Date;
      label: string;
      plant: { id: string; name: string };
    }
  | {
      kind: "event";
      id: string;
      timestamp: Date;
      type: string;
      notes: string | null;
      photoId: string | null;
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
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      plants: {
        include: {
          events: { include: { photo: true } },
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  const entries: TimelineEntry[] = project.plants.flatMap((plant) => [
    {
      kind: "start" as const,
      id: `start-${plant.id}`,
      timestamp: plant.startedAt,
      label: plant.startLabel,
      plant: { id: plant.id, name: plant.name },
    },
    ...plant.events.map((event) => ({
      kind: "event" as const,
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      notes: event.notes,
      photoId: event.photoId,
      cropX: event.cropX,
      cropY: event.cropY,
      cropWidth: event.cropWidth,
      cropHeight: event.cropHeight,
      plant: { id: plant.id, name: plant.name },
      photo: event.photo ? { id: event.photo.id, filename: event.photo.filename } : null,
    })),
  ]);

  entries.sort((a, b) =>
    newestFirst
      ? b.timestamp.getTime() - a.timestamp.getTime()
      : a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const grouped = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }

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
                <h2 className="text-lg font-semibold text-stone-950">{dayLabel(key)}</h2>
                {dayEntries.map((entry) => (
                  <article
                    key={entry.id}
                    className={`rounded-lg border p-5 shadow-sm ${
                      entry.kind === "start"
                        ? "border-emerald-200 bg-emerald-50"
                        : "border-stone-200 bg-white"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <Link href={`/plants/${entry.plant.id}`} className="text-sm font-semibold text-emerald-700">
                          {entry.plant.name}
                        </Link>
                        <h3 className="mt-1 text-lg font-semibold text-stone-950">
                          {entry.kind === "start" ? entry.label : entry.type}
                        </h3>
                        <p className="text-sm text-stone-500">
                          {formatDateTime(entry.timestamp)}
                        </p>
                        {entry.kind === "start" ? (
                          <p className="mt-2 text-sm text-emerald-900">Plant starting entry</p>
                        ) : entry.notes ? (
                          <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700">
                            {entry.notes}
                          </p>
                        ) : null}
                      </div>

                      {entry.kind === "event" ? (
                        <div className="grid gap-2 justify-items-start sm:justify-items-end">
                          {entry.photo ? (
                            <Link className="button-secondary" href={`/photos/${entry.photo.id}`}>
                              Open Photo
                            </Link>
                          ) : null}
                          <EventActions
                            event={{
                              id: entry.id,
                              type: entry.type,
                              notes: entry.notes,
                              timestamp: entry.timestamp.toISOString(),
                              photoId: entry.photoId,
                              cropX: entry.cropX,
                              cropY: entry.cropY,
                              cropWidth: entry.cropWidth,
                              cropHeight: entry.cropHeight,
                            }}
                          />
                        </div>
                      ) : (
                        <Link className="button-secondary" href={`/plants/${entry.plant.id}`}>
                          Edit Plant
                        </Link>
                      )}
                    </div>

                    {entry.kind === "event" && entry.photoId && entry.cropX !== null ? (
                      <div className="mt-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/events/${entry.id}/crop`}
                          alt={`${entry.type} crop`}
                          className="max-h-28 max-w-full rounded-md border border-stone-200 bg-black object-contain"
                        />
                      </div>
                    ) : null}
                  </article>
                ))}
              </section>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
