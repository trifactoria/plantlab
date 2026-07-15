import type { Prisma, PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/projectCapture.ts is server-only operational code.");
}

export type ProjectCaptureMode = "none" | "direct-local" | "capture-source";

export type AvailableCaptureSource = {
  id: string;
  name: string;
  mode: "local" | "remote-node";
  node: { id: string; name: string; role: string } | null;
  logicalCameraName: string | null;
  available: boolean;
  retired: boolean;
  assignmentActive: boolean;
  currentEndpointAvailable: boolean;
  width: number;
  height: number;
  rotation: number;
  inputFormat: string | null;
  lastInventoryAt: string | null;
  lastSuccessfulCapture: string | null;
  recentError: string | null;
  supportsScheduledCapture: boolean;
  selectable: boolean;
};

const SOURCE_INCLUDE = {
  assignments: {
    include: {
      node: true,
      nodeCamera: {
        include: {
          endpoints: { where: { available: true }, orderBy: { observedAt: "desc" as const }, take: 1 },
        },
      },
      jobs: { orderBy: { requestedAt: "desc" as const }, take: 1 },
    },
    orderBy: [{ active: "desc" as const }, { updatedAt: "desc" as const }],
  },
  sourceCaptures: { orderBy: { timestamp: "desc" as const }, take: 1 },
} satisfies Prisma.CaptureSourceInclude;

type CaptureSourceWithStatus = Prisma.CaptureSourceGetPayload<{ include: typeof SOURCE_INCLUDE }>;

export async function listAvailableProjectCaptureSources(prisma: PrismaClient, options: { includeRetired?: boolean } = {}) {
  const sources = await prisma.captureSource.findMany({
    where: options.includeRetired ? undefined : { active: true },
    include: SOURCE_INCLUDE,
    orderBy: [{ name: "asc" }],
  });

  return sources
    .map(serializeAvailableCaptureSource)
    .filter((source) => options.includeRetired || !source.retired);
}

export function serializeAvailableCaptureSource(source: CaptureSourceWithStatus): AvailableCaptureSource {
  const activeAssignment = source.assignments.find((assignment) => assignment.active) ?? null;
  const recentJob = source.assignments.flatMap((assignment) => assignment.jobs).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0] ?? null;
  const retired = Boolean(activeAssignment?.nodeCamera.retiredAt);
  const currentEndpointAvailable = activeAssignment ? activeAssignment.nodeCamera.available && activeAssignment.nodeCamera.endpoints.length > 0 : source.active;
  const assignmentHealthy = activeAssignment
    ? activeAssignment.active && activeAssignment.nodeCamera.enabled && !activeAssignment.nodeCamera.retiredAt && activeAssignment.nodeCamera.available
    : true;
  const available = source.active && assignmentHealthy && currentEndpointAvailable;
  const inputFormat = activeAssignment?.inputFormat ?? null;

  return {
    id: source.id,
    name: source.name,
    mode: activeAssignment ? "remote-node" : "local",
    node: activeAssignment ? { id: activeAssignment.node.id, name: activeAssignment.node.name, role: activeAssignment.node.role } : null,
    logicalCameraName: activeAssignment?.nodeCamera.name ?? source.cameraName,
    available,
    retired,
    assignmentActive: activeAssignment?.active ?? false,
    currentEndpointAvailable,
    width: activeAssignment?.width ?? source.width,
    height: activeAssignment?.height ?? source.height,
    rotation: source.rotation,
    inputFormat,
    lastInventoryAt: activeAssignment?.node.lastInventoryAt?.toISOString() ?? null,
    lastSuccessfulCapture: source.sourceCaptures[0]?.timestamp.toISOString() ?? null,
    recentError: recentJob?.status === "failed" ? recentJob.errorMessage : null,
    supportsScheduledCapture: available,
    selectable: available && !retired,
  };
}

export async function validateProjectCaptureSourceSelection(prisma: PrismaClient, captureSourceId: string) {
  const source = await prisma.captureSource.findUnique({
    where: { id: captureSourceId },
    include: SOURCE_INCLUDE,
  });
  if (!source) throw new Error("captureSourceId does not reference an existing capture source.");

  const serialized = serializeAvailableCaptureSource(source);
  if (!source.active) throw new Error("Selected capture source is inactive.");
  if (serialized.retired) throw new Error("Selected capture source is retired.");
  if (!serialized.supportsScheduledCapture) throw new Error("Selected capture source is not currently available for scheduled capture.");
  return { source, serialized };
}

export async function setProjectCaptureSource(
  prisma: Prisma.TransactionClient,
  input: { projectId: string; captureSourceId: string; effectiveFrom?: Date },
) {
  const now = input.effectiveFrom ?? new Date();
  await prisma.projectViewport.updateMany({
    where: { projectId: input.projectId, active: true },
    data: { active: false },
  });
  return prisma.projectViewport.create({
    data: {
      projectId: input.projectId,
      captureSourceId: input.captureSourceId,
      cropX: 0,
      cropY: 0,
      cropWidth: 1,
      cropHeight: 1,
      effectiveFrom: now,
      active: true,
    },
  });
}

export async function projectCaptureSummary(prisma: PrismaClient, projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      viewports: {
        where: { active: true },
        include: { captureSource: { include: SOURCE_INCLUDE } },
        orderBy: { effectiveFrom: "desc" },
        take: 1,
      },
    },
  });
  if (!project) return null;

  const viewport = project.viewports[0] ?? null;
  if (viewport) {
    const source = serializeAvailableCaptureSource(viewport.captureSource);
    return {
      mode: "capture-source" as const,
      captureEnabled: project.captureEnabled,
      viewportId: viewport.id,
      captureSourceId: source.id,
      source,
      degraded: !source.available,
    };
  }

  if (project.cameraDevice) {
    return {
      mode: "direct-local" as const,
      captureEnabled: project.captureEnabled,
      cameraDevice: project.cameraDevice,
      cameraName: project.cameraName,
      degraded: false,
    };
  }

  return { mode: "none" as const, captureEnabled: project.captureEnabled, degraded: false };
}
