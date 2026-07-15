import type { Prisma, PrismaClient } from "@prisma/client";
import { minutesToTimeInput } from "../timezone";
import { nextPermittedCaptureTime } from "../schedule";
import { SOURCE_INCLUDE, serializeAvailableCaptureSource } from "./projectCapture";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/projectCaptureSchedule.ts is server-only operational code.");
}

const PROJECT_WITH_CAPTURE_INCLUDE = {
  photos: { orderBy: { timestamp: "desc" as const }, take: 1 },
  viewports: {
    where: { active: true },
    include: { captureSource: { include: SOURCE_INCLUDE } },
    orderBy: { effectiveFrom: "desc" as const },
    take: 1,
  },
} satisfies Prisma.ProjectInclude;

type ProjectWithCapture = Prisma.ProjectGetPayload<{ include: typeof PROJECT_WITH_CAPTURE_INCLUDE }>;

export type EffectiveProjectCaptureSchedule = {
  mode: "none" | "direct-local" | "capture-source";
  enabled: boolean;
  owner: "project" | "capture-source" | null;
  intervalMinutes: number | null;
  timeZone: string | null;
  dailyWindow: { enabled: boolean; start: string | null; end: string | null } | null;
  nextCaptureAt: string | null;
  captureSource: { id: string; name: string; nodeName: string | null } | null;
  legacyProjectSchedulePresent: boolean;
  conflict: { exists: boolean; reason: string | null };
};

export type ProjectCaptureSummaryDetails = {
  project: { id: string; name: string };
  mode: "none" | "direct-local" | "capture-source";
  effectiveSchedule: EffectiveProjectCaptureSchedule;
  selectedCamera:
    | { mode: "direct-local"; cameraDevice: string; cameraName: string | null; cameraStableId: string | null }
    | {
        mode: "capture-source";
        captureSourceId: string;
        name: string;
        nodeName: string | null;
        available: boolean;
        retired: boolean;
        assignmentActive: boolean;
        currentEndpointAvailable: boolean;
        width: number;
        height: number;
        inputFormat: string | null;
      }
    | null;
  latestCapture: { id: string; capturedAt: string; sourceCaptureId: string | null; viewportId: string | null } | null;
  nextCaptureAt: string | null;
  degraded: boolean;
  unavailableReason: string | null;
};

export async function getEffectiveProjectCaptureSchedule(prisma: PrismaClient, projectId: string, now = new Date()) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: PROJECT_WITH_CAPTURE_INCLUDE,
  });
  if (!project) return null;
  return effectiveScheduleForProject(project, now);
}

export async function getProjectCaptureSummaryDetails(prisma: PrismaClient, projectId: string, now = new Date()) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: PROJECT_WITH_CAPTURE_INCLUDE,
  });
  if (!project) return null;
  const effectiveSchedule = effectiveScheduleForProject(project, now);
  const viewport = project.viewports[0] ?? null;
  const sourceSummary = viewport ? serializeAvailableCaptureSource(viewport.captureSource) : null;
  const latest = project.photos[0] ?? null;

  return {
    project: { id: project.id, name: project.name },
    mode: effectiveSchedule.mode,
    effectiveSchedule,
    selectedCamera: sourceSummary
      ? {
          mode: "capture-source" as const,
          captureSourceId: sourceSummary.id,
          name: sourceSummary.name,
          nodeName: sourceSummary.node?.name ?? null,
          available: sourceSummary.available,
          retired: sourceSummary.retired,
          assignmentActive: sourceSummary.assignmentActive,
          currentEndpointAvailable: sourceSummary.currentEndpointAvailable,
          width: sourceSummary.width,
          height: sourceSummary.height,
          inputFormat: sourceSummary.inputFormat,
        }
      : project.cameraDevice
        ? {
            mode: "direct-local" as const,
            cameraDevice: project.cameraDevice,
            cameraName: project.cameraName,
            cameraStableId: project.cameraStableId,
          }
        : null,
    latestCapture: latest
      ? {
          id: latest.id,
          capturedAt: latest.timestamp.toISOString(),
          sourceCaptureId: latest.sourceCaptureId,
          viewportId: latest.viewportId,
        }
      : null,
    nextCaptureAt: effectiveSchedule.nextCaptureAt,
    degraded: sourceSummary ? !sourceSummary.available || sourceSummary.retired || !sourceSummary.assignmentActive || !sourceSummary.currentEndpointAvailable : false,
    unavailableReason: sourceSummary && !sourceSummary.available ? sourceSummary.recentError ?? "Selected capture source is not currently usable." : null,
  } satisfies ProjectCaptureSummaryDetails;
}

function effectiveScheduleForProject(project: ProjectWithCapture, now: Date): EffectiveProjectCaptureSchedule {
  const viewport = project.viewports[0] ?? null;
  if (viewport) {
    const source = viewport.captureSource;
    const sourceSummary = serializeAvailableCaptureSource(source);
    const conflictReasons = [
      project.cameraDevice || project.cameraName || project.cameraStableId || project.cameraProfileId ? "CaptureSource project still has legacy direct-local camera fields." : null,
      !source.active ? "CaptureSource schedule is disabled because the source is inactive." : null,
      sourceSummary.retired ? "Selected CaptureSource camera is retired." : null,
    ].filter(Boolean) as string[];
    const nextCaptureAt = source.active
      ? nextPermittedCaptureTime({
          startAt: source.captureStartAt,
          intervalMinutes: source.photoIntervalMinutes,
          now,
          timeZone: source.timeZone,
          captureWindowEnabled: source.captureWindowEnabled,
          captureWindowStartMinutes: source.captureWindowStartMinutes,
          captureWindowEndMinutes: source.captureWindowEndMinutes,
        })?.toISOString() ?? null
      : null;

    return {
      mode: "capture-source",
      enabled: source.active,
      owner: "capture-source",
      intervalMinutes: source.photoIntervalMinutes,
      timeZone: source.timeZone,
      dailyWindow: dailyWindowFor(source),
      nextCaptureAt,
      captureSource: { id: source.id, name: source.name, nodeName: sourceSummary.node?.name ?? null },
      legacyProjectSchedulePresent: hasLegacyProjectScheduleFields(project, source),
      conflict: { exists: conflictReasons.length > 0, reason: conflictReasons[0] ?? null },
    };
  }

  if (project.cameraDevice) {
    const nextCaptureAt = project.captureEnabled
      ? nextPermittedCaptureTime({
          startAt: project.captureStartAt,
          intervalMinutes: project.photoIntervalMinutes,
          now,
          timeZone: project.timeZone,
          captureWindowEnabled: project.captureWindowEnabled,
          captureWindowStartMinutes: project.captureWindowStartMinutes,
          captureWindowEndMinutes: project.captureWindowEndMinutes,
        })?.toISOString() ?? null
      : null;
    return {
      mode: "direct-local",
      enabled: project.captureEnabled,
      owner: "project",
      intervalMinutes: project.photoIntervalMinutes,
      timeZone: project.timeZone,
      dailyWindow: dailyWindowFor(project),
      nextCaptureAt,
      captureSource: null,
      legacyProjectSchedulePresent: false,
      conflict: { exists: false, reason: null },
    };
  }

  return {
    mode: "none",
    enabled: false,
    owner: null,
    intervalMinutes: null,
    timeZone: null,
    dailyWindow: null,
    nextCaptureAt: null,
    captureSource: null,
    legacyProjectSchedulePresent: Boolean(project.captureEnabled || project.cameraName || project.cameraStableId || project.cameraProfileId),
    conflict: {
      exists: project.captureEnabled,
      reason: project.captureEnabled ? "Project capture is enabled but no camera or CaptureSource is selected." : null,
    },
  };
}

function dailyWindowFor(config: {
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
}) {
  return {
    enabled: config.captureWindowEnabled,
    start: config.captureWindowStartMinutes === null ? null : minutesToTimeInput(config.captureWindowStartMinutes),
    end: config.captureWindowEndMinutes === null ? null : minutesToTimeInput(config.captureWindowEndMinutes),
  };
}

function hasLegacyProjectScheduleFields(project: ProjectWithCapture, source: ProjectWithCapture["viewports"][number]["captureSource"]) {
  return Boolean(
    project.captureEnabled ||
      project.cameraDevice ||
      project.cameraName ||
      project.cameraStableId ||
      project.cameraProfileId ||
      project.photoIntervalMinutes !== source.photoIntervalMinutes ||
      project.timeZone !== source.timeZone ||
      project.captureWindowEnabled !== source.captureWindowEnabled ||
      project.captureWindowStartMinutes !== source.captureWindowStartMinutes ||
      project.captureWindowEndMinutes !== source.captureWindowEndMinutes,
  );
}
