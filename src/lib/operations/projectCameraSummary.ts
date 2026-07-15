import type { Prisma, PrismaClient } from "@prisma/client";
import { nextAlignedCaptureTime, nextPermittedCaptureTime } from "../schedule";
import { serializeDailyWindow } from "./captureSourceConfig";
import { nodeCameraBaseDisplayName } from "./nodeCameras";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/projectCameraSummary.ts is server-only operational code.");
}

const PROJECT_CAMERA_SUMMARY_INCLUDE = {
  photos: { orderBy: { timestamp: "desc" as const }, take: 1 },
  viewports: {
    where: { active: true },
    orderBy: { effectiveFrom: "desc" as const },
    take: 1,
    include: {
      captureSource: {
        include: {
          illuminationOutlet: true,
          sourceCaptures: { orderBy: { timestamp: "desc" as const }, take: 1 },
          occurrences: { orderBy: { scheduledFor: "desc" as const }, take: 1 },
          assignments: {
            where: { active: true },
            orderBy: { updatedAt: "desc" as const },
            take: 1,
            include: { node: true, nodeCamera: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ProjectInclude;

type ProjectWithCameraSummary = Prisma.ProjectGetPayload<{ include: typeof PROJECT_CAMERA_SUMMARY_INCLUDE }>;

export async function getProjectCameraSummary(prisma: PrismaClient, projectId: string, now = new Date()) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: PROJECT_CAMERA_SUMMARY_INCLUDE,
  });
  if (!project) return null;
  return serializeProjectCameraSummary(prisma, project, now);
}

async function serializeProjectCameraSummary(prisma: PrismaClient, project: ProjectWithCameraSummary, now: Date) {
  const viewport = project.viewports[0] ?? null;
  if (!viewport) {
    return {
      mode: project.cameraDevice ? ("direct-local" as const) : ("none" as const),
      camera: project.cameraDevice
        ? {
            id: project.cameraStableId ?? project.cameraDevice,
            displayName: project.cameraName ?? project.cameraDevice,
            reportedName: project.cameraName,
            nodeName: "local",
            available: Boolean(project.cameraDevice),
            configurationUrl: `/projects/${encodeURIComponent(project.id)}/settings`,
            detailsUrl: `/projects/${encodeURIComponent(project.id)}/camera`,
          }
        : null,
      source: null,
      projectSampling: {
        enabled: false,
        intervalMinutes: null,
        nextSampleAt: null,
        lastSampleAt: null,
        missingRecentSampleCount: 0,
      },
      latestCapture: latestProjectCapture(project),
      recentOccurrence: null,
      legacy: {
        directProjectSchedulePresent: Boolean(project.cameraDevice || project.captureEnabled),
        conflict: project.captureEnabled && !project.cameraDevice ? "Project capture is enabled but no camera is selected." : null,
      },
    };
  }

  const source = viewport.captureSource;
  const assignment = source.assignments[0] ?? null;
  const latestSourceCapture = source.sourceCaptures[0] ?? null;
  const latestPhoto = project.photos[0] ?? null;
  const recentOccurrence = source.occurrences[0] ?? null;
  const missingRecentSampleCount = await prisma.projectSourceSample.count({
    where: {
      projectId: project.id,
      viewportId: viewport.id,
      status: "missing",
      sampleSlotAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) },
    },
  });
  const nextSourceCaptureAt = source.active
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
  const samplingIntervalMinutes = viewport.samplingIntervalMinutes ?? project.photoIntervalMinutes;
  const nextSampleAt = viewport.samplingEnabled
    ? nextAlignedCaptureTime({
        startAt: viewport.samplingAnchorAt ?? viewport.effectiveFrom,
        intervalMinutes: samplingIntervalMinutes,
        now,
      }).toISOString()
    : null;

  return {
    mode: "capture-source" as const,
    camera: assignment
      ? {
          id: assignment.nodeCamera.id,
          displayName: nodeCameraBaseDisplayName(assignment.nodeCamera),
          reportedName: assignment.nodeCamera.reportedName,
          nodeName: assignment.node.name,
          available: assignment.nodeCamera.available && assignment.nodeCamera.enabled && assignment.nodeCamera.retiredAt === null,
          configurationUrl: `/nodes/${encodeURIComponent(assignment.node.name)}/cameras`,
          detailsUrl: `/nodes/${encodeURIComponent(assignment.node.name)}/cameras`,
        }
      : {
          id: source.id,
          displayName: source.cameraName ?? source.name,
          reportedName: source.cameraName,
          nodeName: "local",
          available: source.active,
          configurationUrl: `/capture-sources/${encodeURIComponent(source.id)}`,
          detailsUrl: `/capture-sources/${encodeURIComponent(source.id)}`,
        },
    source: {
      id: source.id,
      name: source.name,
      enabled: source.active,
      cadence: {
        intervalMinutes: source.photoIntervalMinutes,
        timeZone: source.timeZone,
        dailyWindow: serializeDailyWindow(source),
        nextCaptureAt: nextSourceCaptureAt,
      },
      illumination: {
        policy: source.illuminationPolicy === "only-while-on" ? "only-while-on" : "unrestricted",
        outletId: source.illuminationOutletId,
        outletKey: source.illuminationOutlet?.key ?? null,
        outletLabel: source.illuminationOutlet?.name ?? null,
        observedState: source.illuminationOutlet?.actualState ?? null,
        observedAt: source.illuminationOutlet?.stateObservedAt?.toISOString() ?? null,
      },
      mode: assignment
        ? {
            width: assignment.width,
            height: assignment.height,
            inputFormat: assignment.inputFormat,
            frameRate: assignment.frameRate,
          }
        : {
            width: source.width,
            height: source.height,
            inputFormat: source.cameraProfileId ? "profile" : "unknown",
            frameRate: null,
          },
    },
    projectSampling: {
      enabled: viewport.samplingEnabled,
      intervalMinutes: samplingIntervalMinutes,
      nextSampleAt,
      lastSampleAt: viewport.lastSampledSlotAt?.toISOString() ?? null,
      missingRecentSampleCount,
    },
    latestCapture: latestSourceCapture
      ? {
          scheduledFor: latestSourceCapture.scheduledFor?.toISOString() ?? null,
          capturedAt: latestSourceCapture.timestamp.toISOString(),
          validationStatus: "unknown",
          fallbackUsed: false,
          projectPhotoId: latestPhoto?.sourceCaptureId === latestSourceCapture.id ? latestPhoto.id : null,
        }
      : null,
    recentOccurrence: recentOccurrence
      ? {
          status: recentOccurrence.status,
          skipReason: recentOccurrence.skipReason,
          scheduledFor: recentOccurrence.scheduledFor.toISOString(),
        }
      : null,
    legacy: {
      directProjectSchedulePresent: hasLegacyDirectProjectSchedule(project, source),
      conflict: source.active ? null : "Selected CaptureSource is disabled.",
    },
  };
}

function latestProjectCapture(project: ProjectWithCameraSummary) {
  const latest = project.photos[0] ?? null;
  return latest
    ? {
        scheduledFor: null,
        capturedAt: latest.timestamp.toISOString(),
        validationStatus: "unknown",
        fallbackUsed: false,
        projectPhotoId: latest.id,
      }
    : null;
}

function hasLegacyDirectProjectSchedule(
  project: ProjectWithCameraSummary,
  source: ProjectWithCameraSummary["viewports"][number]["captureSource"],
) {
  return Boolean(
    project.cameraDevice ||
      project.cameraName ||
      project.cameraStableId ||
      project.cameraProfileId ||
      project.photoIntervalMinutes !== source.photoIntervalMinutes ||
      project.captureWindowEnabled !== source.captureWindowEnabled ||
      project.captureWindowStartMinutes !== source.captureWindowStartMinutes ||
      project.captureWindowEndMinutes !== source.captureWindowEndMinutes,
  );
}
