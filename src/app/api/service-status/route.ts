import { NextResponse } from "next/server";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { prisma } from "@/lib/prisma";
import { getProjectCaptureStatus, getServiceStatusSnapshot } from "@/lib/serviceStatus";

export const runtime = "nodejs";

export async function GET() {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const now = new Date();
  const [service, projects] = await Promise.all([
    getServiceStatusSnapshot(prisma, now),
    prisma.project.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const projectStatuses = await Promise.all(
    projects.map(async (project) => ({
      name: project.name,
      ...(await getProjectCaptureStatus(prisma, project, now)),
    })),
  );

  const activeProjects = projectStatuses.filter((status) => status.captureEnabled && status.eligible);
  const nextCaptureTimes = activeProjects
    .map((status) => status.nextCaptureAt)
    .filter((value): value is string => value !== null)
    .sort();

  return NextResponse.json({
    service,
    activeProjectCount: activeProjects.length,
    nextScheduledCaptureAt: nextCaptureTimes[0] ?? null,
    projects: projectStatuses,
  });
}
