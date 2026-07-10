import type { PrismaClient } from "@prisma/client";
import { checkCaptureEligibility } from "./captureEligibility";
import { withCameraLock } from "./cameraLock";
import { nextAlignedCaptureTime } from "./schedule";

export type CaptureLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export const consoleLogger: CaptureLogger = {
  info(message, meta) {
    console.log(JSON.stringify({ level: "info", message, ...meta, time: new Date().toISOString() }));
  },
  warn(message, meta) {
    console.warn(JSON.stringify({ level: "warn", message, ...meta, time: new Date().toISOString() }));
  },
  error(message, meta) {
    console.error(JSON.stringify({ level: "error", message, ...meta, time: new Date().toISOString() }));
  },
};

export type CaptureFn = (
  projectId: string,
  options?: { notes?: string | null },
) => Promise<{ photo: { id: string }; savedPath: string }>;

export type CaptureSchedulerDeps = {
  prisma: PrismaClient;
  captureProjectPhoto: CaptureFn;
  now?: () => Date;
  logger?: CaptureLogger;
  minWakeDelayMs?: number;
};

type TrackedSchedule = {
  target: Date;
  captureStartAt: Date;
  photoIntervalMinutes: number;
};

export type TickCaptureResult = {
  projectId: string;
  status: "success" | "failed";
  scheduledFor: Date;
  errorMessage?: string;
};

export type TickResult = {
  checkedAt: Date;
  dueCount: number;
  captures: TickCaptureResult[];
};

/**
 * A single in-process scheduler that tracks the next aligned capture time
 * for every capture-enabled project. Re-reads project configuration from
 * the database on every tick, so enabling/disabling/editing/deleting a
 * project takes effect on the next tick without restarting the process.
 */
export class CaptureScheduler {
  private readonly prisma: PrismaClient;
  private readonly captureProjectPhoto: CaptureFn;
  private readonly now: () => Date;
  private readonly logger: CaptureLogger;
  private readonly minWakeDelayMs: number;
  private readonly schedules = new Map<string, TrackedSchedule>();

  constructor(deps: CaptureSchedulerDeps) {
    this.prisma = deps.prisma;
    this.captureProjectPhoto = deps.captureProjectPhoto;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? consoleLogger;
    this.minWakeDelayMs = deps.minWakeDelayMs ?? 250;
  }

  /** One scheduling pass: refresh config, capture anything due, return a summary. */
  async tick(): Promise<TickResult> {
    const checkedAt = this.now();
    const projects = await this.prisma.project.findMany();
    const seenIds = new Set<string>();

    const dueProjects: Array<{
      id: string;
      cameraDevice: string;
      captureStartAt: Date;
      photoIntervalMinutes: number;
      target: Date;
    }> = [];

    for (const project of projects) {
      seenIds.add(project.id);

      if (!project.captureEnabled) {
        this.schedules.delete(project.id);
        continue;
      }

      const eligibility = await checkCaptureEligibility({
        captureEnabled: project.captureEnabled,
        captureStartAt: project.captureStartAt,
        photoIntervalMinutes: project.photoIntervalMinutes,
        cameraDevice: project.cameraDevice,
        localPhotoDirectory: project.localPhotoDirectory,
      });

      if (!eligibility.eligible) {
        if (this.schedules.has(project.id)) {
          this.logger.warn("Project no longer eligible for scheduled capture", {
            projectId: project.id,
            errors: eligibility.errors,
          });
        }
        this.schedules.delete(project.id);
        continue;
      }

      const existing = this.schedules.get(project.id);
      const configChanged =
        !existing ||
        existing.captureStartAt.getTime() !== project.captureStartAt.getTime() ||
        existing.photoIntervalMinutes !== project.photoIntervalMinutes;

      let schedule: TrackedSchedule;
      if (configChanged) {
        schedule = {
          target: nextAlignedCaptureTime({
            startAt: project.captureStartAt,
            intervalMinutes: project.photoIntervalMinutes,
            now: checkedAt,
          }),
          captureStartAt: project.captureStartAt,
          photoIntervalMinutes: project.photoIntervalMinutes,
        };
        this.schedules.set(project.id, schedule);
      } else {
        schedule = existing;
      }

      if (schedule.target.getTime() <= checkedAt.getTime()) {
        dueProjects.push({
          id: project.id,
          cameraDevice: project.cameraDevice as string,
          captureStartAt: schedule.captureStartAt,
          photoIntervalMinutes: schedule.photoIntervalMinutes,
          target: schedule.target,
        });
      }
    }

    // Prune schedules for projects that were deleted.
    for (const projectId of this.schedules.keys()) {
      if (!seenIds.has(projectId)) {
        this.schedules.delete(projectId);
      }
    }

    const captures = await Promise.all(
      dueProjects.map((project) => this.captureDueProject(project)),
    );

    return { checkedAt, dueCount: dueProjects.length, captures };
  }

  private async captureDueProject(project: {
    id: string;
    cameraDevice: string;
    captureStartAt: Date;
    photoIntervalMinutes: number;
    target: Date;
  }): Promise<TickCaptureResult> {
    const scheduledFor = project.target;
    const captureRun = await this.prisma.captureRun.create({
      data: {
        projectId: project.id,
        scheduledFor,
        status: "running",
        cameraDevice: project.cameraDevice,
      },
    });

    let result: TickCaptureResult;

    try {
      await withCameraLock(project.cameraDevice, async () => {
        await this.prisma.captureRun.update({
          where: { id: captureRun.id },
          data: { startedAt: this.now() },
        });

        this.logger.info("Starting scheduled capture", {
          projectId: project.id,
          cameraDevice: project.cameraDevice,
          scheduledFor: scheduledFor.toISOString(),
        });

        const captured = await this.captureProjectPhoto(project.id);

        await this.prisma.captureRun.update({
          where: { id: captureRun.id },
          data: {
            status: "success",
            completedAt: this.now(),
            photoId: captured.photo.id,
          },
        });

        this.logger.info("Scheduled capture succeeded", {
          projectId: project.id,
          scheduledFor: scheduledFor.toISOString(),
          savedPath: captured.savedPath,
        });
      });

      result = { projectId: project.id, status: "success", scheduledFor };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Capture failed";

      await this.prisma.captureRun.update({
        where: { id: captureRun.id },
        data: { status: "failed", completedAt: this.now(), errorMessage: message },
      });

      this.logger.error("Scheduled capture failed", {
        projectId: project.id,
        scheduledFor: scheduledFor.toISOString(),
        error: message,
      });

      result = { projectId: project.id, status: "failed", scheduledFor, errorMessage: message };
    } finally {
      // Recompute the next aligned slot from the post-attempt clock so a
      // slow or delayed capture never causes missed intervals to be
      // backfilled - only the next future occurrence is scheduled.
      const recomputedNow = this.now();
      this.schedules.set(project.id, {
        target: nextAlignedCaptureTime({
          startAt: project.captureStartAt,
          intervalMinutes: project.photoIntervalMinutes,
          now: recomputedNow,
        }),
        captureStartAt: project.captureStartAt,
        photoIntervalMinutes: project.photoIntervalMinutes,
      });
    }

    return result;
  }

  /** Milliseconds to sleep before the next tick is worth running. */
  msUntilNextWake(refreshIntervalMs: number): number {
    const now = this.now().getTime();
    let earliest = now + refreshIntervalMs;

    for (const schedule of this.schedules.values()) {
      if (schedule.target.getTime() < earliest) {
        earliest = schedule.target.getTime();
      }
    }

    return Math.max(this.minWakeDelayMs, earliest - now);
  }

  /** Snapshot of tracked next-capture times, keyed by project id. Used for status reporting. */
  getTrackedSchedules(): ReadonlyMap<string, { target: Date }> {
    return this.schedules;
  }
}
