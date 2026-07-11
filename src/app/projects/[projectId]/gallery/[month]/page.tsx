import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { groupPhotosByDay, localMonthRange, monthLabel } from "@/lib/gallery";
import { prisma } from "@/lib/prisma";
import { formatDateTimeInZone } from "@/lib/timezone";

type PageProps = {
  params: Promise<{ projectId: string; month: string }>;
};

export default async function ProjectMonthGalleryPage({ params }: PageProps) {
  const { projectId, month } = await params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project || !/^\d{4}-\d{2}$/.test(month)) {
    notFound();
  }

  const { start, end } = localMonthRange(month, project.timeZone);
  const photos = await prisma.photo.findMany({
    where: {
      projectId,
      timestamp: { gte: start, lt: end },
    },
    orderBy: { timestamp: "desc" },
    select: { id: true, timestamp: true },
  });
  const dayCards = groupPhotosByDay(photos, project.timeZone);

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${project.id}`} className="text-sm font-semibold text-emerald-700">
            {project.name}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">
            {monthLabel(month, project.timeZone)}
          </h1>
        </div>
      </header>

      <section className="section">
        <div className="container">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {dayCards.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                No photos found for this month.
              </p>
            ) : (
              dayCards.map((day) => (
                <Link
                  key={day.key}
                  href={`/projects/${project.id}/gallery/${month}/${day.key.slice(8, 10)}`}
                  className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm transition hover:border-cyan-300"
                >
                  <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-stone-100">
                    <Image
                      src={`/api/photos/${day.representativePhoto.id}/file`}
                      alt={day.label}
                      fill
                      sizes="(max-width: 1024px) 50vw, 260px"
                      className="object-cover"
                    />
                  </div>
                  <p className="mt-2 text-sm font-semibold text-stone-950">{day.label}</p>
                  <p className="text-xs text-stone-500">
                    {day.photoCount} photo{day.photoCount === 1 ? "" : "s"} / {formatDateTimeInZone(day.firstCaptureAt, project.timeZone)} - {formatDateTimeInZone(day.lastCaptureAt, project.timeZone)}
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
