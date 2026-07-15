import type { PrismaClient } from "@prisma/client";
import { validateCaptureConfig } from "./captureValidation";
import { nextPermittedCaptureTime } from "./schedule";
import type { CaptureSourceResult } from "./sourceCapture";
import type { ViewportFanOutResult } from "./viewportFanOut";
import { consoleLogger, type CaptureLogger } from "./captureService";

export type CaptureSourceFn = (
  captureSourceId: string,
  options?: { scheduledFor?: Date },
) => Promise<CaptureSourceResult>;

export type FanOutFn = (sourceCaptureId: string) => Promise<ViewportFanOutResult>;

export type CaptureSourceSchedulerDeps = {
  prisma: PrismaClient;
  captureSourcePhoto: CaptureSourceFn;
  runViewportFanOut: FanOutFn;
  now?: () => Date;
  logger?: CaptureLogger;
  minWakeDelayMs?: number;
};

type TrackedSchedule = {
  target: Date;
  captureStartAt: Date;
  photoIntervalMinutes: number;
  timeZone: string;
  captureWindowEnabled: boolean;
  captureWindowStartMinutes: number | null;
  captureWindowEndMinutes: number | null;
};

export type TickCaptureSourceResult = {
  captureSourceId: string;
  status: "success" | "skipped" | "queued" | "failed";
  scheduledFor: Date;
  sourceCaptureId?: string;
  agentCaptureJobId?: string;
  fanOut?: ViewportFanOutResult;
  errorMessage?: string;
};

export type TickResult = {
  checkedAt: Date;
  dueCount: number;
  captures: TickCaptureSourceResult[];
};

/**
 * Schedules shared CaptureSources independently of per-project schedules
 * (CaptureScheduler in captureService.ts, which is untouched by this
 * class). One due source is captured exactly once here and then fanned out
 * to every project with an applicable viewport - never captured once per
 * subscribing project. Structurally mirrors CaptureScheduler (same
 * tick/track/wake shape) so both schedulers can run side by side from the
 * same capture-service process.
 */
export class CaptureSourceScheduler {
  private readonly prisma: PrismaClient;
  private readonly captureSourcePhoto: CaptureSourceFn;
  private readonly runViewportFanOut: FanOutFn;
  private readonly now: () => Date;
  private readonly logger: CaptureLogger;
  private readonly minWakeDelayMs: number;
  private readonly schedules = new Map<string, TrackedSchedule>();

  constructor(deps: CaptureSourceSchedulerDeps) {
    this.prisma = deps.prisma;
    this.captureSourcePhoto = deps.captureSourcePhoto;
    this.runViewportFanOut = deps.runViewportFanOut;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? consoleLogger;
    this.minWakeDelayMs = deps.minWakeDelayMs ?? 250;
  }

  async tick(): Promise<TickResult> {
    const checkedAt = this.now();
    const sources = await this.prisma.captureSource.findMany({
      include: {
        assignments: {
          where: { active: true, nodeCamera: { available: true, enabled: true, retiredAt: null } },
          include: { nodeCamera: true },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
      },
    });
    const seenIds = new Set<string>();

    const dueSources: Array<{
      id: string;
      cameraDevice: string;
      assignmentId: string | null;
      nodeId: string | null;
      captureStartAt: Date;
      photoIntervalMinutes: number;
      timeZone: string;
      captureWindowEnabled: boolean;
      captureWindowStartMinutes: number | null;
      captureWindowEndMinutes: number | null;
      target: Date;
    }> = [];

    for (const source of sources) {
      seenIds.add(source.id);

      if (!source.active) {
        this.schedules.delete(source.id);
        continue;
      }

      const errors = validateCaptureConfig({
        captureStartAt: source.captureStartAt,
        photoIntervalMinutes: source.photoIntervalMinutes,
        cameraDevice: source.cameraDevice,
        localPhotoDirectory: source.captureDirectory,
        timeZone: source.timeZone,
        captureWindowEnabled: source.captureWindowEnabled,
        captureWindowStartMinutes: source.captureWindowStartMinutes,
        captureWindowEndMinutes: source.captureWindowEndMinutes,
      });

      if (errors.length > 0) {
        if (this.schedules.has(source.id)) {
          this.logger.warn("Capture source no longer eligible for scheduled capture", {
            captureSourceId: source.id,
            errors,
          });
        }
        this.schedules.delete(source.id);
        continue;
      }

      const existing = this.schedules.get(source.id);
      const configChanged =
        !existing ||
        existing.captureStartAt.getTime() !== source.captureStartAt.getTime() ||
        existing.photoIntervalMinutes !== source.photoIntervalMinutes ||
        existing.timeZone !== source.timeZone ||
        existing.captureWindowEnabled !== source.captureWindowEnabled ||
        existing.captureWindowStartMinutes !== source.captureWindowStartMinutes ||
        existing.captureWindowEndMinutes !== source.captureWindowEndMinutes;

      let schedule: TrackedSchedule;
      if (configChanged) {
        const target = nextPermittedCaptureTime({
          startAt: source.captureStartAt,
          intervalMinutes: source.photoIntervalMinutes,
          now: checkedAt,
          timeZone: source.timeZone,
          captureWindowEnabled: source.captureWindowEnabled,
          captureWindowStartMinutes: source.captureWindowStartMinutes,
          captureWindowEndMinutes: source.captureWindowEndMinutes,
        });
        if (!target) {
          this.schedules.delete(source.id);
          this.logger.warn("No permitted capture time found within the scheduling lookahead", {
            captureSourceId: source.id,
          });
          continue;
        }
        schedule = {
          target,
          captureStartAt: source.captureStartAt,
          photoIntervalMinutes: source.photoIntervalMinutes,
          timeZone: source.timeZone,
          captureWindowEnabled: source.captureWindowEnabled,
          captureWindowStartMinutes: source.captureWindowStartMinutes,
          captureWindowEndMinutes: source.captureWindowEndMinutes,
        };
        this.schedules.set(source.id, schedule);
      } else {
        schedule = existing;
      }

      if (schedule.target.getTime() <= checkedAt.getTime()) {
        dueSources.push({
          id: source.id,
          cameraDevice: source.cameraDevice,
          assignmentId: source.assignments[0]?.id ?? null,
          nodeId: source.assignments[0]?.nodeId ?? null,
          captureStartAt: schedule.captureStartAt,
          photoIntervalMinutes: schedule.photoIntervalMinutes,
          timeZone: schedule.timeZone,
          captureWindowEnabled: schedule.captureWindowEnabled,
          captureWindowStartMinutes: schedule.captureWindowStartMinutes,
          captureWindowEndMinutes: schedule.captureWindowEndMinutes,
          target: schedule.target,
        });
      }
    }

    for (const captureSourceId of this.schedules.keys()) {
      if (!seenIds.has(captureSourceId)) {
        this.schedules.delete(captureSourceId);
      }
    }

    const captures = await Promise.all(dueSources.map((source) => this.captureDueSource(source)));

    return { checkedAt, dueCount: dueSources.length, captures };
  }

  private async captureDueSource(source: {
    id: string;
    cameraDevice: string;
    assignmentId: string | null;
    nodeId: string | null;
    captureStartAt: Date;
    photoIntervalMinutes: number;
    timeZone: string;
    captureWindowEnabled: boolean;
    captureWindowStartMinutes: number | null;
    captureWindowEndMinutes: number | null;
    target: Date;
  }): Promise<TickCaptureSourceResult> {
    const scheduledFor = source.target;
    let result: TickCaptureSourceResult;

    try {
      if (source.assignmentId && source.nodeId) {
        const existing = await this.prisma.agentCaptureJob.findFirst({
          where: { captureSourceId: source.id, scheduledFor, status: { in: ["queued", "claimed", "completed", "failed"] } },
          orderBy: { requestedAt: "asc" },
        });
        if (existing) {
          result =
            existing.status === "failed"
              ? { captureSourceId: source.id, status: "failed", scheduledFor, agentCaptureJobId: existing.id, errorMessage: existing.errorMessage ?? "Remote capture job failed." }
              : { captureSourceId: source.id, status: "queued", scheduledFor, agentCaptureJobId: existing.id, sourceCaptureId: existing.sourceCaptureId ?? undefined };
        } else {
          const job = await this.prisma.agentCaptureJob.create({
            data: {
              nodeId: source.nodeId,
              assignmentId: source.assignmentId,
              captureSourceId: source.id,
              scheduledFor,
              status: "queued",
            },
          });
          this.logger.info("Queued scheduled remote source capture", {
            captureSourceId: source.id,
            agentCaptureJobId: job.id,
            scheduledFor: scheduledFor.toISOString(),
          });
          result = { captureSourceId: source.id, status: "queued", scheduledFor, agentCaptureJobId: job.id };
        }
        return result;
      }

      this.logger.info("Starting scheduled source capture", {
        captureSourceId: source.id,
        cameraDevice: source.cameraDevice,
        scheduledFor: scheduledFor.toISOString(),
      });

      const captured = await this.captureSourcePhoto(source.id, { scheduledFor });

      if (captured.alreadyExisted) {
        // A retried or overlapping tick already captured and fanned out
        // this slot - never re-run fan-out for the same capture.
        this.logger.info("Source capture already existed for this slot, skipping fan-out", {
          captureSourceId: source.id,
          scheduledFor: scheduledFor.toISOString(),
        });
        result = {
          captureSourceId: source.id,
          status: "skipped",
          scheduledFor,
          sourceCaptureId: captured.sourceCapture.id,
        };
      } else {
        const fanOut = await this.runViewportFanOut(captured.sourceCapture.id);

        await Promise.all(
          fanOut.projectResults.map((projectResult) =>
            this.prisma.captureRun.create({
              data: {
                projectId: projectResult.projectId,
                scheduledFor,
                startedAt: this.now(),
                completedAt: this.now(),
                status: projectResult.status,
                photoId: projectResult.photoId ?? null,
                errorMessage: projectResult.errorMessage ?? null,
                cameraDevice: source.cameraDevice,
              },
            }),
          ),
        );

        this.logger.info("Scheduled source capture and fan-out succeeded", {
          captureSourceId: source.id,
          scheduledFor: scheduledFor.toISOString(),
          projectCount: fanOut.projectResults.length,
        });

        result = {
          captureSourceId: source.id,
          status: "success",
          scheduledFor,
          sourceCaptureId: captured.sourceCapture.id,
          fanOut,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Source capture failed";
      this.logger.error("Scheduled source capture failed", {
        captureSourceId: source.id,
        scheduledFor: scheduledFor.toISOString(),
        error: message,
      });
      result = { captureSourceId: source.id, status: "failed", scheduledFor, errorMessage: message };
    } finally {
      const recomputedNow = this.now();
      const target = nextPermittedCaptureTime({
        startAt: source.captureStartAt,
        intervalMinutes: source.photoIntervalMinutes,
        now: recomputedNow,
        timeZone: source.timeZone,
        captureWindowEnabled: source.captureWindowEnabled,
        captureWindowStartMinutes: source.captureWindowStartMinutes,
        captureWindowEndMinutes: source.captureWindowEndMinutes,
      });
      if (target) {
        this.schedules.set(source.id, {
          target,
          captureStartAt: source.captureStartAt,
          photoIntervalMinutes: source.photoIntervalMinutes,
          timeZone: source.timeZone,
          captureWindowEnabled: source.captureWindowEnabled,
          captureWindowStartMinutes: source.captureWindowStartMinutes,
          captureWindowEndMinutes: source.captureWindowEndMinutes,
        });
      } else {
        this.schedules.delete(source.id);
      }
    }

    return result;
  }

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

  getTrackedSchedules(): ReadonlyMap<string, { target: Date }> {
    return this.schedules;
  }
}
