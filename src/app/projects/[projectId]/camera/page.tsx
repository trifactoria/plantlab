import Link from "next/link";
import { notFound } from "next/navigation";
import { CameraSetupPanel } from "@/components/CameraSetupPanel";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { nextAlignedCaptureTime } from "@/lib/schedule";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectCameraPage({ params }: PageProps) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { cameraProfile: true },
  });

  if (!project) {
    notFound();
  }

  const nextCaptureAt = nextAlignedCaptureTime({
    startAt: project.captureStartAt,
    intervalMinutes: project.photoIntervalMinutes,
  });
  const production =
    process.env.NODE_ENV === "production" &&
    process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI !== "1";

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href={`/projects/${project.id}`} className="text-sm font-semibold text-emerald-700">
            {project.name}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">Camera Setup</h1>
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="grid content-start gap-4">
            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-stone-950">Capture Schedule</h2>
              <dl className="mt-4 grid gap-3 text-sm">
                <div>
                  <dt className="font-medium text-stone-950">Selected camera</dt>
                  <dd className="text-stone-600">
                    {project.cameraDevice
                      ? `${project.cameraName ?? "Camera"} (${project.cameraDevice})`
                      : "No camera selected"}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Interval</dt>
                  <dd className="text-stone-600">{project.photoIntervalMinutes} minutes</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Schedule start</dt>
                  <dd className="text-stone-600">{formatDateTime(project.captureStartAt)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Next aligned capture</dt>
                  <dd className="text-stone-600">{formatDateTime(nextCaptureAt)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Watcher command</dt>
                  <dd className="break-all font-mono text-xs text-stone-600">
                    pnpm camera:watch -- {project.id}
                  </dd>
                </div>
              </dl>
            </div>
          </aside>

          {production ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950">
              Local camera controls are unavailable in production. Run PlantLab locally to inspect V4L2 cameras, preview the selected device, and adjust hardware controls.
            </div>
          ) : (
            <CameraSetupPanel
              projectId={project.id}
              cameraDevice={project.cameraDevice}
              cameraName={project.cameraName}
              cameraProfileId={project.cameraProfileId}
            />
          )}
        </div>
      </section>
    </main>
  );
}
