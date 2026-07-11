import Link from "next/link";
import { CaptureSourceForm } from "@/components/CaptureSourceForm";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function CaptureSourcesPage() {
  const sources = await prisma.captureSource.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { viewports: true, sourceCaptures: true } } },
  });

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-6">
          <Link href="/" className="text-sm font-semibold text-emerald-700">
            Home
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">Shelf Cameras</h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            A shelf camera is one physical camera that sees an entire grow-tent shelf. Several
            projects can each claim a rectangular area of its frame instead of running their own
            direct capture - see each shelf camera&apos;s layout editor to assign project areas.
          </p>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[1fr_420px]">
          <div>
            <h2 className="text-xl font-semibold text-stone-950">Existing shelf cameras</h2>
            <div className="mt-4 grid gap-3">
              {sources.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-stone-600">
                  No shelf cameras yet. Direct per-project capture keeps working unchanged whether
                  or not any shelf cameras exist.
                </p>
              ) : (
                sources.map((source) => (
                  <Link
                    key={source.id}
                    href={`/capture-sources/${source.id}`}
                    className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm transition hover:border-emerald-300"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-stone-950">{source.name}</h3>
                        <p className="mt-1 text-sm text-stone-600">
                          {source.cameraName ?? "Camera"} ({source.cameraDevice})
                        </p>
                      </div>
                      <span
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                          source.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"
                        }`}
                      >
                        {source.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <dl className="mt-4 grid gap-3 text-sm text-stone-600 sm:grid-cols-4">
                      <div>
                        <dt className="font-medium text-stone-950">Working frame</dt>
                        <dd>
                          {source.width} x {source.height}
                          {source.rotation !== 0 ? ` (rotated ${source.rotation}°)` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-stone-950">Project areas</dt>
                        <dd>{source._count.viewports}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-stone-950">Captures taken</dt>
                        <dd>{source._count.sourceCaptures}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-stone-950">Interval</dt>
                        <dd>{source.photoIntervalMinutes} minutes</dd>
                      </div>
                    </dl>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-stone-950">New Shelf Camera</h2>
            <div className="mt-4">
              <CaptureSourceForm />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
