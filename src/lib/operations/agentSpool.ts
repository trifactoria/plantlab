import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/agentSpool.ts touches local agent files and must not run in a browser.");
}

export type SpoolState = "pending" | "uploading" | "acknowledged" | "failed";

export type SpoolRecord = {
  jobId: string;
  captureId: string;
  assignmentId: string;
  captureSourceId: string;
  localFilePath: string;
  capturedAt: string;
  sha256: string;
  byteSize: number;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  state: SpoolState;
};

export class AgentSpool {
  readonly root: string;
  private db: DatabaseSync | null = null;

  constructor(root: string) {
    this.root = root;
  }

  async init() {
    await mkdir(this.dir("pending"), { recursive: true });
    await mkdir(this.dir("uploading"), { recursive: true });
    await mkdir(this.dir("acknowledged"), { recursive: true });
    await mkdir(this.dir("failed"), { recursive: true });
    await mkdir(this.dir("logs"), { recursive: true });

    this.db = new DatabaseSync(path.join(this.root, "state.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spool_records (
        jobId TEXT PRIMARY KEY,
        captureId TEXT NOT NULL UNIQUE,
        assignmentId TEXT NOT NULL,
        captureSourceId TEXT NOT NULL,
        localFilePath TEXT NOT NULL,
        capturedAt TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byteSize INTEGER NOT NULL,
        attemptCount INTEGER NOT NULL DEFAULT 0,
        nextRetryAt TEXT,
        lastError TEXT,
        state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spool_records_state_nextRetryAt_idx ON spool_records(state, nextRetryAt);
    `);
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  dir(name: SpoolState | "logs") {
    return path.join(this.root, name === "logs" ? "logs" : "spool", name);
  }

  pendingPath(captureId: string) {
    return path.join(this.dir("pending"), `${captureId}.jpg`);
  }

  async recordCaptured(input: {
    jobId: string;
    captureId: string;
    assignmentId: string;
    captureSourceId: string;
    localFilePath: string;
    capturedAt: Date;
  }): Promise<SpoolRecord> {
    const checksum = await sha256File(input.localFilePath);
    const fileStat = await stat(input.localFilePath);
    const record: SpoolRecord = {
      jobId: input.jobId,
      captureId: input.captureId,
      assignmentId: input.assignmentId,
      captureSourceId: input.captureSourceId,
      localFilePath: input.localFilePath,
      capturedAt: input.capturedAt.toISOString(),
      sha256: checksum,
      byteSize: fileStat.size,
      attemptCount: 0,
      nextRetryAt: null,
      lastError: null,
      state: "pending",
    };

    this.database()
      .prepare(
        `INSERT OR REPLACE INTO spool_records
          (jobId, captureId, assignmentId, captureSourceId, localFilePath, capturedAt, sha256, byteSize, attemptCount, nextRetryAt, lastError, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.jobId,
        record.captureId,
        record.assignmentId,
        record.captureSourceId,
        record.localFilePath,
        record.capturedAt,
        record.sha256,
        record.byteSize,
        record.attemptCount,
        record.nextRetryAt,
        record.lastError,
        record.state,
      );
    return record;
  }

  dueUploads(now = new Date()): SpoolRecord[] {
    return this.database()
      .prepare(
        `SELECT * FROM spool_records
         WHERE state IN ('pending', 'failed') AND (nextRetryAt IS NULL OR nextRetryAt <= ?)
         ORDER BY capturedAt ASC`,
      )
      .all(now.toISOString()) as SpoolRecord[];
  }

  markUploading(jobId: string): SpoolRecord | null {
    const record = this.get(jobId);
    if (!record) return null;
    const nextPath = path.join(this.dir("uploading"), path.basename(record.localFilePath));
    this.database()
      .prepare("UPDATE spool_records SET state = 'uploading', localFilePath = ?, attemptCount = attemptCount + 1 WHERE jobId = ?")
      .run(nextPath, jobId);
    return { ...record, localFilePath: nextPath, state: "uploading", attemptCount: record.attemptCount + 1 };
  }

  async moveFileForState(record: SpoolRecord, state: SpoolState): Promise<SpoolRecord> {
    const nextPath = path.join(this.dir(state), path.basename(record.localFilePath));
    if (record.localFilePath !== nextPath) {
      await mkdir(path.dirname(nextPath), { recursive: true });
      await rename(record.localFilePath, nextPath).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    this.database().prepare("UPDATE spool_records SET state = ?, localFilePath = ? WHERE jobId = ?").run(state, nextPath, record.jobId);
    return { ...record, state, localFilePath: nextPath };
  }

  markFailed(jobId: string, error: string, now = new Date()) {
    const record = this.get(jobId);
    const attempts = record?.attemptCount ?? 1;
    const backoffMs = Math.min(5 * 60_000, Math.max(5_000, attempts * 10_000));
    this.database()
      .prepare("UPDATE spool_records SET state = 'failed', lastError = ?, nextRetryAt = ? WHERE jobId = ?")
      .run(error.slice(0, 2000), new Date(now.getTime() + backoffMs).toISOString(), jobId);
  }

  markAcknowledged(jobId: string) {
    this.database().prepare("UPDATE spool_records SET state = 'acknowledged', nextRetryAt = NULL, lastError = NULL WHERE jobId = ?").run(jobId);
  }

  async cleanupAcknowledged(retainMs: number, now = new Date()) {
    const cutoff = new Date(now.getTime() - retainMs).toISOString();
    const rows = this.database()
      .prepare("SELECT * FROM spool_records WHERE state = 'acknowledged' AND capturedAt <= ?")
      .all(cutoff) as SpoolRecord[];
    for (const row of rows) {
      await rm(row.localFilePath, { force: true }).catch(() => undefined);
      this.database().prepare("DELETE FROM spool_records WHERE jobId = ?").run(row.jobId);
    }
    return rows.length;
  }

  get(jobId: string): SpoolRecord | null {
    return (this.database().prepare("SELECT * FROM spool_records WHERE jobId = ?").get(jobId) as SpoolRecord | undefined) ?? null;
  }

  summary() {
    return this.database()
      .prepare("SELECT state, COUNT(*) as count FROM spool_records GROUP BY state")
      .all() as Array<{ state: SpoolState; count: number }>;
  }

  private database() {
    if (!this.db) {
      throw new Error("AgentSpool has not been initialized.");
    }
    return this.db;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
