import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ plantId: string }>;
};

export default async function PlantPage({ params }: PageProps) {
  const { plantId } = await params;
  const plant = await prisma.plant.findUnique({
    where: { id: plantId },
    include: {
      project: true,
      events: {
        include: { photo: true },
        orderBy: { timestamp: "desc" },
      },
    },
  });

  if (!plant) {
    notFound();
  }

  const linkedPhotos = Array.from(
    new Map(
      plant.events
        .filter((event) => event.photo)
        .map((event) => [event.photo!.id, event.photo!]),
    ).values(),
  ).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${plant.projectId}`} className="text-sm font-semibold text-emerald-700">
            {plant.project.name}
          </Link>
          <div className="mt-3">
            <h1 className="text-3xl font-semibold text-stone-950">{plant.name}</h1>
            <p className="mt-1 text-stone-600">
              Grid {plant.gridX + 1}, {plant.gridY + 1}
            </p>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="grid content-start gap-4">
            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Plant</h2>
              <dl className="mt-4 grid gap-3 text-sm">
                <div>
                  <dt className="font-medium text-stone-950">Tags</dt>
                  <dd className="text-stone-600">{plant.tags || "None"}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Notes</dt>
                  <dd className="whitespace-pre-wrap text-stone-600">
                    {plant.notes || "No notes yet."}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Linked Photos</h2>
              <div className="mt-4 grid gap-3">
                {linkedPhotos.length === 0 ? (
                  <p className="text-sm text-stone-600">No linked photos yet.</p>
                ) : (
                  linkedPhotos.map((photo) => (
                    <Link key={photo.id} href={`/photos/${photo.id}`} className="block">
                      <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                        <Image
                          src={`/api/photos/${photo.id}/file`}
                          alt={photo.filename}
                          fill
                          sizes="320px"
                          className="object-cover"
                        />
                      </div>
                      <p className="mt-1 truncate text-sm font-medium text-stone-950">
                        {photo.filename}
                      </p>
                    </Link>
                  ))
                )}
              </div>
            </div>
          </aside>

          <div>
            <h2 className="text-xl font-semibold text-stone-950">Timeline</h2>
            <div className="mt-4 grid gap-3">
              {plant.events.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                  No events recorded yet.
                </p>
              ) : (
                plant.events.map((event) => (
                  <article
                    key={event.id}
                    className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-stone-950">
                          {event.type}
                        </h3>
                        <p className="text-sm text-stone-500">
                          {formatDateTime(event.timestamp)}
                        </p>
                      </div>
                      {event.photo ? (
                        <Link className="button-secondary" href={`/photos/${event.photo.id}`}>
                          Open Photo
                        </Link>
                      ) : null}
                    </div>
                    {event.notes ? (
                      <p className="mt-3 whitespace-pre-wrap text-sm text-stone-700">
                        {event.notes}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
