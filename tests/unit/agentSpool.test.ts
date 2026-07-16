import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSpool } from "../../src/lib/operations/agentSpool";

describe("AgentSpool", () => {
  it("tracks durable capture state transitions and retry metadata in local SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plantlab-agent-spool-"));
    const spool = new AgentSpool(root);
    await spool.init();
    try {
      const filePath = spool.pendingPath("capture-1");
      await writeFile(filePath, "fake-jpeg");
      const record = await spool.recordCaptured({
        jobId: "job-1",
        captureId: "capture-1",
        assignmentId: "assignment-1",
        captureSourceId: "source-1",
        localFilePath: filePath,
        capturedAt: new Date("2026-07-12T12:00:00Z"),
        metadata: { validationStatus: "accepted", attempts: [{ attempt: 1, status: "accepted" }] },
      });

      expect(record.sha256).toHaveLength(64);
      expect(record.metadataJson).toContain("validationStatus");
      expect(spool.dueUploads()).toHaveLength(1);

      const uploading = await spool.moveFileForState(record, "uploading");
      expect(uploading.localFilePath).toContain(path.join("spool", "uploading"));
      expect(uploading.metadataJson).toContain("accepted");
      spool.markFailed(uploading.jobId, "network down", new Date("2026-07-12T12:00:00Z"));
      expect(spool.dueUploads(new Date("2026-07-12T12:00:01Z"))).toHaveLength(0);

      const failed = spool.get(uploading.jobId)!;
      expect(failed.state).toBe("failed");
      const acknowledged = await spool.moveFileForState(failed, "acknowledged");
      spool.markAcknowledged(acknowledged.jobId);
      expect(spool.summary()).toEqual([{ state: "acknowledged", count: 1 }]);
    } finally {
      spool.close();
    }
  });
});
