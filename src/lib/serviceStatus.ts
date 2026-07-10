import os from "node:os";
import type { PrismaClient, Project } from "@prisma/client";
import { checkCaptureEligibility } from "./captureEligibility";
import { nextAlignedCaptureTime } from "./schedule";

export const SERVICE_STATUS_ID = "capture-service";
export const SERVICE_NAME = "plantlab-capture";
export const DEFAULT_STALE_HEARTBEAT_MS = 45_000;

export type ServiceHealth = "running" | "stale" | "offline";

export async function writeHeartbeat(
  prisma: PrismaClient,
  input: { startedAt: Date; lastError?: string | null; now?: Date },
) {
  const now = input.now ?? new Date();

  await prisma.serviceStatus.upsert({
    where: { id: SERVICE_STATUS_ID },
    create: {
      id: SERVICE_STATUS_ID,
      name: SERVICE_NAME,
      startedAt: input.startedAt,
      lastHeartbeat: now,
      pid: process.pid,
      hostname: os.hostname(),
      version: process.env.npm_package_version ?? null,
      lastError: input.lastError ?? null,
    },
    update: {
      lastHeartbeat: now,
      pid: process.pid,
      hostname: os.hostname(),
      lastError: input.lastError ?? null,
    },
  });
}

export function computeServiceHealth(
  status: { lastHeartbeat: Date } | null,
  now: Date = new Date(),
  staleAfterMs: number = DEFAULT_STALE_HEARTBEAT_MS,
): ServiceHealth {
  if (!status) {
    return "offline";
  }

  const age = now.getTime() - status.lastHeartbeat.getTime();
  return age > staleAfterMs ? "stale" : "running";
}

export type ProjectCaptureStatus = {
  projectId: string;
  captureEnabled: boolean;
  eligible: boolean;
  errors: string[];
  nextCaptureAt: string | null;
  lastSuccessfulCaptureAt: string | null;
  lastError: { message: string; at: string } | null;
};

export async function getProjectCaptureStatus(
  prisma: PrismaClient,
  project: Project,
  now: Date = new Date(),
): Promise<ProjectCaptureStatus> {
  const eligibility = await checkCaptureEligibility({
    captureEnabled: project.captureEnabled,
    captureStartAt: project.captureStartAt,
    photoIntervalMinutes: project.photoIntervalMinutes,
    cameraDevice: project.cameraDevice,
    localPhotoDirectory: project.localPhotoDirectory,
  });

  const nextCaptureAt = eligibility.eligible
    ? nextAlignedCaptureTime({
        startAt: project.captureStartAt,
        intervalMinutes: project.photoIntervalMinutes,
        now,
      })
    : null;

  const [lastSuccess, lastFailure] = await Promise.all([
    prisma.captureRun.findFirst({
      where: { projectId: project.id, status: "success" },
      orderBy: { scheduledFor: "desc" },
    }),
    prisma.captureRun.findFirst({
      where: { projectId: project.id, status: "failed" },
      orderBy: { scheduledFor: "desc" },
    }),
  ]);

  const lastError =
    lastFailure && (!lastSuccess || lastFailure.scheduledFor.getTime() > lastSuccess.scheduledFor.getTime())
      ? {
          message: lastFailure.errorMessage ?? "Capture failed",
          at: (lastFailure.completedAt ?? lastFailure.createdAt).toISOString(),
        }
      : null;

  return {
    projectId: project.id,
    captureEnabled: project.captureEnabled,
    eligible: eligibility.eligible,
    errors: eligibility.errors,
    nextCaptureAt: nextCaptureAt ? nextCaptureAt.toISOString() : null,
    lastSuccessfulCaptureAt: lastSuccess
      ? (lastSuccess.completedAt ?? lastSuccess.createdAt).toISOString()
      : null,
    lastError,
  };
}

export async function getServiceStatusSnapshot(prisma: PrismaClient, now: Date = new Date()) {
  const status = await prisma.serviceStatus.findUnique({ where: { id: SERVICE_STATUS_ID } });

  return {
    health: computeServiceHealth(status, now),
    startedAt: status?.startedAt.toISOString() ?? null,
    lastHeartbeat: status?.lastHeartbeat.toISOString() ?? null,
    pid: status?.pid ?? null,
    hostname: status?.hostname ?? null,
    version: status?.version ?? null,
    lastError: status?.lastError ?? null,
  };
}
