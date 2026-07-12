import type { Command } from "commander";
import { getProjectCaptureStatus } from "../../lib/serviceStatus";
import { prisma } from "../../lib/prisma";
import { effectiveProjectLifecycleState, isValidProjectLifecycleState, PROJECT_LIFECYCLE_STATES } from "../../lib/projectLifecycle";

export function registerProjectCommand(program: Command): void {
  const project = program.command("project").description("Inspect projects and manage their lifecycle metadata");

  project
    .command("list")
    .description("List every project with its lifecycle state and camera assignment")
    .action(async () => {
      try {
        const projects = await prisma.project.findMany({
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, lifecycleState: true, captureEnabled: true, cameraDevice: true, cameraName: true },
        });

        if (projects.length === 0) {
          console.log("No projects found.");
          return;
        }

        for (const p of projects) {
          const camera = p.cameraDevice ? `${p.cameraName ?? "Camera"} (${p.cameraDevice})` : "no direct camera";
          console.log(`${p.id}\t${p.name}\t${effectiveProjectLifecycleState(p.lifecycleState)}\t${p.captureEnabled ? "capture-enabled" : "capture-disabled"}\t${camera}`);
        }
      } finally {
        await prisma.$disconnect();
      }
    });

  project
    .command("show")
    .description("Show one project's lifecycle state and capture status")
    .argument("<projectId>")
    .action(async (projectId: string) => {
      try {
        const p = await prisma.project.findUnique({ where: { id: projectId } });
        if (!p) {
          console.error(`No project found with id ${projectId}`);
          process.exitCode = 1;
          return;
        }

        console.log(`${p.name} (${p.id})`);
        console.log(`  lifecycle: ${effectiveProjectLifecycleState(p.lifecycleState)}`);
        console.log(`  created:   ${p.createdAt.toISOString()}`);

        const status = await getProjectCaptureStatus(prisma, p);
        console.log(`  capture:   ${status.captureEnabled ? "enabled" : "disabled"}${status.eligible ? "" : " (not currently eligible)"}`);
        console.log(`  next capture: ${status.nextCaptureAt ?? "(none scheduled)"}`);
        if (status.errors.length > 0) {
          console.log(`  eligibility issues: ${status.errors.join("; ")}`);
        }
      } finally {
        await prisma.$disconnect();
      }
    });

  project
    .command("set-lifecycle")
    .description(`Set a project's lifecycle state (${PROJECT_LIFECYCLE_STATES.join(", ")})`)
    .argument("<projectId>")
    .argument("<state>")
    .action(async (projectId: string, state: string) => {
      try {
        const normalized = state.toUpperCase();
        if (!isValidProjectLifecycleState(normalized)) {
          console.error(`Invalid lifecycle state "${state}". Valid values: ${PROJECT_LIFECYCLE_STATES.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        const existing = await prisma.project.findUnique({ where: { id: projectId } });
        if (!existing) {
          console.error(`No project found with id ${projectId}`);
          process.exitCode = 1;
          return;
        }

        await prisma.project.update({ where: { id: projectId }, data: { lifecycleState: normalized } });
        console.log(`${existing.name} (${projectId}): lifecycle set to ${normalized}.`);
      } finally {
        await prisma.$disconnect();
      }
    });
}
