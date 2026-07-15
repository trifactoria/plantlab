import type { PrismaClient } from "@prisma/client";
import { captureProjectPhoto } from "../camera";
import { captureSourcePhoto } from "../sourceCapture";
import { runViewportFanOut } from "../viewportFanOut";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/projectManualCapture.ts is server-only operational code.");
}

export type ProjectManualCaptureResult =
  | { mode: "direct-local"; status: "completed"; photoId: string; savedPath: string }
  | {
      mode: "local-capture-source";
      status: "completed";
      sourceCaptureId: string;
      fanOutPhotoIds: string[];
      illuminationState: boolean | null;
      illuminationWarning: boolean;
    }
  | {
      mode: "remote-job";
      status: "queued";
      jobId: string;
      captureSourceId: string;
      reused: boolean;
      illuminationState: boolean | null;
      illuminationWarning: boolean;
    };

export async function captureProjectManually(
  prisma: PrismaClient,
  projectId: string,
  options: { notes?: string | null; allowLocalHardware?: boolean } = {},
): Promise<ProjectManualCaptureResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      viewports: {
        where: { active: true },
        orderBy: { effectiveFrom: "desc" },
        take: 1,
        include: {
          captureSource: {
            include: {
              assignments: {
                where: { active: true },
                include: { nodeCamera: true, node: true },
                orderBy: { updatedAt: "desc" },
                take: 1,
              },
              illuminationOutlet: true,
            },
          },
        },
      },
    },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const viewport = project.viewports[0] ?? null;
  if (viewport) {
    const source = viewport.captureSource;
    const illumination = manualIlluminationMetadata(source);
    if (!source.active) {
      throw new Error("The selected capture source is inactive.");
    }

    const assignment = source.assignments[0] ?? null;
    if (!assignment) {
      const captured = await captureSourcePhoto(source.id);
      const fanOut = await runViewportFanOut(captured.sourceCapture.id, { projectId });
      return {
        mode: "local-capture-source",
        status: "completed",
        sourceCaptureId: captured.sourceCapture.id,
        fanOutPhotoIds: fanOut.projectResults.flatMap((result) => (result.photoId ? [result.photoId] : [])),
        ...illumination,
      };
    }

    if (!assignment.active) {
      throw new Error("The selected camera assignment is inactive.");
    }
    if (!assignment.nodeCamera.enabled) {
      throw new Error("The selected node camera is disabled.");
    }
    if (assignment.nodeCamera.retiredAt) {
      throw new Error("The selected node camera is retired.");
    }
    if (!assignment.nodeCamera.available) {
      throw new Error("The selected node camera is currently unavailable.");
    }

    const existing = await prisma.agentCaptureJob.findFirst({
      where: {
        captureSourceId: source.id,
        scheduledFor: null,
        manualProjectId: project.id,
        status: { in: ["queued", "claimed"] },
      },
      orderBy: { requestedAt: "asc" },
    });
    if (existing) {
      return { mode: "remote-job", status: "queued", jobId: existing.id, captureSourceId: source.id, reused: true, ...illumination };
    }

    const job = await prisma.agentCaptureJob.create({
      data: {
        nodeId: assignment.nodeId,
        assignmentId: assignment.id,
        captureSourceId: source.id,
        manualProjectId: project.id,
        status: "queued",
      },
    });
    return { mode: "remote-job", status: "queued", jobId: job.id, captureSourceId: source.id, reused: false, ...illumination };
  }

  if (project.cameraDevice) {
    if (options.allowLocalHardware === false) {
      throw new Error("Local physical camera hardware is unavailable on this coordinator.");
    }
    const captured = await captureProjectPhoto(projectId, options);
    return { mode: "direct-local", status: "completed", photoId: captured.photo.id, savedPath: captured.savedPath };
  }

  throw new Error("This project has no configured camera or capture source.");
}

function manualIlluminationMetadata(source: {
  illuminationPolicy: string;
  illuminationOutlet: { actualState: boolean | null } | null;
}) {
  const illuminationState = source.illuminationOutlet?.actualState ?? null;
  return {
    illuminationState,
    illuminationWarning: source.illuminationPolicy === "only-while-on" && illuminationState === false,
  };
}

export async function getProjectCaptureJobStatus(prisma: PrismaClient, projectId: string, jobId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const job = await prisma.agentCaptureJob.findUnique({
    where: { id: jobId },
    include: { captureSource: true },
  });
  if (!job) throw new Error(`Capture job not found: ${jobId}`);

  const viewport = await prisma.projectViewport.findFirst({
    where: { projectId, captureSourceId: job.captureSourceId, active: true },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!viewport) {
    throw new Error("Capture job does not belong to this project's active capture source.");
  }

  const photo = job.sourceCaptureId
    ? await prisma.photo.findFirst({
        where: { projectId, sourceCaptureId: job.sourceCaptureId },
        orderBy: { createdAt: "desc" },
      })
    : null;

  return {
    mode: "remote-job" as const,
    jobId: job.id,
    status: job.status,
    captureSourceId: job.captureSourceId,
    sourceCaptureId: job.sourceCaptureId,
    photoId: photo?.id ?? null,
    errorMessage: job.errorMessage,
    timing: {
      requestedAt: job.requestedAt.toISOString(),
      scheduledFor: job.scheduledFor?.toISOString() ?? null,
      claimedAt: job.claimedAt?.toISOString() ?? null,
      captureStartedAt: job.captureStartedAt?.toISOString() ?? null,
      frameCapturedAt: job.frameCapturedAt?.toISOString() ?? null,
      uploadStartedAt: job.uploadStartedAt?.toISOString() ?? null,
      ingestedAt: job.ingestedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      queueLatencyMs: job.queueLatencyMs,
      scheduleToCaptureMs: job.scheduleToCaptureMs,
      captureDurationMs: job.captureDurationMs,
      uploadDurationMs: job.uploadDurationMs,
      totalDurationMs: job.totalDurationMs,
      scheduledLatenessMs: job.scheduledLatenessMs,
      late: job.late,
    },
    capture: {
      effectiveWidth: job.effectiveWidth,
      effectiveHeight: job.effectiveHeight,
      effectiveInputFormat: job.effectiveInputFormat,
      effectiveFrameRate: job.effectiveFrameRate,
      warmupFrames: job.warmupFrames,
      attemptCount: job.attemptCount,
      fallbackUsed: job.fallbackUsed,
      validationStatus: job.validationStatus,
      validationErrorCode: job.validationErrorCode,
    },
  };
}
