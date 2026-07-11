import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dayLabel, localDayRange } from "@/lib/gallery";
import { prisma } from "@/lib/prisma";
import { formatDateTimeInZone } from "@/lib/timezone";

type PageProps = {
  params: Promise<{ projectId: string; month: string; day: string }>;
};

export default async function ProjectDayGalleryPage({ params }: PageProps) {
  const { projectId, month, day } = await params;
  const dayKey = `${month}-${day}`;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    notFound();
  }

  const { start, end } = localDayRange(dayKey, project.timeZone);
  const photos = await prisma.photo.findMany({
    where: {
      projectId,
      timestamp: { gte: start, lt: end },
    },
    orderBy: { timestamp: "desc" },
    include: {
      _count: { select: { events: true } },
    },
  });

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${project.id}/gallery/${month}`} className="text-sm font-semibold text-emerald-700">
            {project.name} / {month}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">
            {dayLabel(dayKey, project.timeZone)}
          </h1>
        </div>
      </header>

      <section className="section">
        <div className="container">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {photos.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                No photos found for this day.
              </p>
            ) : (
              photos.map((photo) => (
                <Link
                  key={photo.id}
                  href={`/photos/${photo.id}`}
                  className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300"
                >
                  <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                    <Image
                      src={`/api/photos/${photo.id}/file`}
                      alt={photo.filename}
                      fill
                      sizes="(max-width: 1024px) 50vw, 260px"
                      className="object-cover"
                    />
                  </div>
                  <p className="mt-2 text-sm font-semibold text-stone-950">
                    {formatDateTimeInZone(photo.timestamp, project.timeZone)}
                  </p>
                  <p className="text-xs text-stone-500">
                    {photo._count.events} event{photo._count.events === 1 ? "" : "s"}
                    {photo.notes ? " / notes" : ""}
                  </p>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
