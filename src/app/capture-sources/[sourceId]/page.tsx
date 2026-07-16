import Link from "next/link";
import { notFound } from "next/navigation";
import { CameraConfigurationForm } from "@/components/camera/CameraConfigurationForm";
import { ShelfLayoutEditor } from "@/components/ShelfLayoutEditor";
import { canDiscoverLocalCameraHardware } from "@/lib/localOnly";
import { getFleetCamera } from "@/lib/operations/fleetHardware";
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
        include: { node: true },
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
  // A node-backed camera is fully configurable from the coordinator through the
  // canonical fleet contracts, regardless of local hardware availability.
  const fleetCamera = assignment ? await getFleetCamera(prisma, assignment.nodeCameraId) : null;
  const outlets = assignment
    ? await prisma.nodeOutlet.findMany({ where: { nodeId: assignment.nodeId }, select: { id: true, key: true, name: true }, orderBy: { key: "asc" } })
    : [];

  const shelfSourceProps = {
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
  };

  const title = fleetCamera?.displayName ?? source.name;
  const reportedName = fleetCamera?.reportedName ?? source.cameraName;
  const localExecutionUnavailable = !assignment && !canDiscoverLocalCameraHardware();

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-5">
          <Link href="/capture-sources" className="text-sm font-semibold text-emerald-700">
            Shelf Cameras
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-stone-950">{title}</h1>
          {reportedName && reportedName !== title ? (
            <p className="mt-1 text-sm text-stone-500">Reported by hardware: {reportedName}</p>
          ) : null}
          {fleetCamera ? (
            <p className="mt-1 text-sm text-stone-600">
              Camera on{" "}
              <Link href={`/nodes/${encodeURIComponent(fleetCamera.node.name)}`} className="font-medium text-emerald-700 hover:underline">
                {fleetCamera.node.name}
              </Link>
            </p>
          ) : null}
        </div>
      </header>

      <section className="section">
        <div className="container grid gap-6">
          {fleetCamera ? (
            <CameraConfigurationForm
              camera={fleetCamera}
              source={{
                captureSourceId: source.id,
                scheduleEnabled: source.active,
                intervalMinutes: source.photoIntervalMinutes,
                timeZone: source.timeZone,
                windowEnabled: source.captureWindowEnabled,
                windowStartMinutes: source.captureWindowStartMinutes,
                windowEndMinutes: source.captureWindowEndMinutes,
                illuminationOutletId: source.illuminationOutletId,
                illuminationPolicy: source.illuminationPolicy === "only-while-on" ? "only-while-on" : "unrestricted",
              }}
              outlets={outlets}
            />
          ) : null}

          {localExecutionUnavailable ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950">
              Local camera controls are unavailable in production. Run PlantLab locally to capture test frames and adjust the shelf layout.
            </div>
          ) : (
            <ShelfLayoutEditor source={shelfSourceProps} projects={projects} hideCameraConfig={fleetCamera !== null} />
          )}
        </div>
      </section>
    </main>
  );
}
