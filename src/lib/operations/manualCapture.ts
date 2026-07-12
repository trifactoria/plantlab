import type { PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/manualCapture.ts is server-only operational code.");
}

export async function createManualCaptureJob(prisma: PrismaClient, input: { nodeName: string; assignmentId?: string | null }) {
  const node = await prisma.plantLabNode.findUniqueOrThrow({
    where: { name: input.nodeName },
    include: {
      assignments: {
        where: { active: true, ...(input.assignmentId ? { id: input.assignmentId } : {}) },
        include: { captureSource: true, nodeCamera: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (node.assignments.length === 0) {
    throw new Error(`Node "${input.nodeName}" has no attached cameras. Run "plantlab camera attach --node ${input.nodeName}" first.`);
  }
  if (!input.assignmentId && node.assignments.length > 1) {
    throw new Error(`Node "${input.nodeName}" has more than one attached camera. Pass --assignment <id> or use --json to inspect choices.`);
  }

  const assignment = node.assignments[0];
  const existingActive = await prisma.agentCaptureJob.findFirst({
    where: { nodeId: node.id, assignmentId: assignment.id, status: { in: ["queued", "claimed"] } },
    orderBy: { requestedAt: "asc" },
  });
  if (existingActive) {
    return { node, assignment, job: existingActive, reused: true };
  }

  const job = await prisma.agentCaptureJob.create({
    data: {
      nodeId: node.id,
      assignmentId: assignment.id,
      captureSourceId: assignment.captureSourceId,
      status: "queued",
    },
  });

  return { node, assignment, job, reused: false };
}

export async function waitForJobCompletion(
  prisma: PrismaClient,
  jobId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1500;
  const started = Date.now();
  let last = null;

  while (Date.now() - started < timeoutMs) {
    last = await prisma.agentCaptureJob.findUnique({
      where: { id: jobId },
      include: { captureSource: true },
    });
    if (last?.status === "completed" || last?.status === "failed") {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return last;
}
