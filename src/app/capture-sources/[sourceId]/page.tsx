import Link from "next/link";
import { notFound } from "next/navigation";
import { ShelfLayoutEditor } from "@/components/ShelfLayoutEditor";
import { canDiscoverLocalCameraHardware } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ sourceId: string }>;
};

export default async function CaptureSourcePage({ params }: PageProps) {
  const { sourceId } = await params;
  const source = await prisma.captureSource.findUnique({
    where: { id: sourceId },
    include: {
      cameraProfile: true,
      assignments: {
        where: { active: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });

  if (!source) {
    notFound();
  }

  const projects = await prisma.project.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, isTestProject: true },
  });

  const assignment = source.assignments[0] ?? null;
  const localExecutionUnavailable = !assignment && !canDiscoverLocalCameraHardware();

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href="/capture-sources" className="text-sm font-semibold text-emerald-700">
            Shelf Cameras
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">{source.name}</h1>
          <p className="mt-1 text-sm text-stone-600">
            {source.cameraName ?? "Camera"} ({source.cameraDevice})
          </p>
        </div>
      </header>

      <section className="section">
        <div className="container">
          {localExecutionUnavailable ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950">
              Local camera controls are unavailable in production. Run PlantLab locally to capture
              test frames and adjust the shelf layout.
            </div>
          ) : (
            <ShelfLayoutEditor
              source={{
                id: source.id,
                name: source.name,
                cameraDevice: source.cameraDevice,
                cameraName: source.cameraName,
                cameraStableId: source.cameraStableId,
                width: source.width,
                height: source.height,
                rotation: source.rotation,
                flipHorizontal: source.flipHorizontal,
                flipVertical: source.flipVertical,
                active: source.active,
                inputFormat: assignment?.inputFormat ?? source.cameraProfile?.inputFormat ?? "mjpeg",
                rawWidth: assignment?.width ?? source.cameraProfile?.width ?? null,
                rawHeight: assignment?.height ?? source.cameraProfile?.height ?? null,
                photoIntervalMinutes: source.photoIntervalMinutes,
                captureStartAt: source.captureStartAt.toISOString(),
                timeZone: source.timeZone,
                captureWindowEnabled: source.captureWindowEnabled,
                captureWindowStartMinutes: source.captureWindowStartMinutes,
                captureWindowEndMinutes: source.captureWindowEndMinutes,
              }}
              projects={projects}
            />
          )}
        </div>
      </section>
    </main>
  );
}
