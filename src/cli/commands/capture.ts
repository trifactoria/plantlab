import type { Command } from "commander";
import { createManualCaptureJob, waitForJobCompletion } from "../../lib/operations/manualCapture";
import { prisma } from "../../lib/prisma";

export function registerCaptureCommand(program: Command): void {
  const capture = program.command("capture").description("Create and monitor coordinator-driven capture jobs");

  capture
    .command("test")
    .description("Ask a camera node to capture one frame and upload it through PlantLab HTTP ingest")
    .requiredOption("--node <name>", "Registered node name, e.g. xps")
    .option("--assignment <id>", "Specific camera assignment id when a node has more than one")
    .option("--timeout-ms <ms>", "Timeout waiting for the remote agent", (value) => Number(value), 120_000)
    .option("--json", "Print structured JSON")
    .action(async (options: { node: string; assignment?: string; timeoutMs: number; json?: boolean }) => {
      try {
        const created = await createManualCaptureJob(prisma, { nodeName: options.node, assignmentId: options.assignment ?? null });
        if (!options.json) {
          console.log(`Testing camera "${created.assignment.name}" on node ${created.node.name}...`);
          console.log(created.reused ? "WARN: Reusing an already queued/claimed test job." : "PASS: Job created");
        }

        const completed = await waitForJobCompletion(prisma, created.job.id, { timeoutMs: options.timeoutMs });
        if (options.json) {
          console.log(JSON.stringify({ created, completed }, null, 2));
          return;
        }

        if (!completed) {
          console.error("FAIL: Job disappeared while waiting for completion.");
          process.exitCode = 1;
          return;
        }
        if (completed.status === "completed") {
          console.log("PASS: Agent claimed job");
          console.log("PASS: Frame uploaded through HTTP ingest");
          console.log("PASS: Coordinator acknowledged capture");
          console.log("");
          console.log("Success.");
          console.log(`CaptureSource: ${completed.captureSource.name}`);
          console.log(`SourceCapture: ${completed.sourceCaptureId ?? "(created, id unavailable)"}`);
          return;
        }
        if (completed.status === "failed") {
          console.error(`FAIL: Remote capture job failed: ${completed.errorMessage ?? "Unknown error"}`);
          console.error("Was anything changed? The failed job was recorded; no canonical SourceCapture was created unless the upload completed first.");
          console.error(`Next step: inspect the remote agent logs with: plantlab service status --node ${options.node}`);
          process.exitCode = 1;
          return;
        }

        console.error(`FAIL: Timed out after ${options.timeoutMs}ms waiting for the agent. Current job status: ${completed.status}`);
        console.error("Was anything changed? A queued or claimed manual job remains on the coordinator for the node to finish.");
        console.error(`Next step: check that plantlab-agent.service is running on ${options.node}.`);
        process.exitCode = 1;
      } finally {
        await prisma.$disconnect();
      }
    });
}
