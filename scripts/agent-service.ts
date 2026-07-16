import "../src/lib/suppressExpectedWarnings";
import { openAsBlob } from "node:fs";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import packageJson from "../package.json";
import { runFfmpeg } from "../src/lib/camera";
import { readNodeConfig } from "../src/lib/operations/config";
import { AgentSpool, sha256File, type SpoolRecord } from "../src/lib/operations/agentSpool";
import { discoverLocalCameras, listCameraFormats } from "../src/lib/v4l2";
import { AGENT_PROTOCOL_VERSION } from "../src/lib/protocolVersion";
import { ImageValidationError, validateImageFile } from "../src/lib/imageValidation";

const POLL_MS = Number(process.env.PLANTLAB_AGENT_POLL_MS ?? 5000);
const ACK_RETAIN_MS = Number(process.env.PLANTLAB_AGENT_ACK_RETAIN_MS ?? 7 * 24 * 60 * 60 * 1000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

function log(level: "info" | "warn" | "error", message: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, message, ...data, time: new Date().toISOString() }));
}

async function requestJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function postHeartbeat(coordinatorUrl: string, token: string, configRole: string) {
  return requestJson(`${coordinatorUrl}/api/agents/heartbeat`, token, {
    method: "POST",
    body: JSON.stringify({
      hostname: os.hostname(),
      role: configRole,
      operatingSystem: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      softwareVersion: packageJson.version,
      runtime: "node",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      // This agent only ever runs the USB/V4L2 camera capture path today -
      // see capabilities.ts "do not implement sensor or relay control yet."
      capabilities: ["camera"],
    }),
  });
}

async function postCameraInventory(coordinatorUrl: string, token: string) {
  const cameras = await Promise.all(
    (await discoverLocalCameras()).map(async (camera) => {
      let formats = camera.formats ?? [];
      let formatsStatus: "ok" | "unavailable" | "error" = camera.supportsCapture ? "ok" : "unavailable";
      let formatsError: string | null = null;
      if (!camera.formats && camera.supportsCapture) {
        try {
          formats = await listCameraFormats(camera.device);
        } catch (error) {
          formats = [];
          formatsStatus = "error";
          formatsError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        stableId: camera.stableId ?? camera.device,
        devicePath: camera.device,
        name: camera.name,
        // A real, ffmpeg-verified capture (Part 5), not just V4L2 metadata
        // claiming "Video Capture" support - metadata alone is what let a
        // Raspberry Pi's non-camera hardware codec/ISP devices (each its own
        // stable-ID group) show up as if they were selectable cameras.
        available: camera.verifiedCapture === true,
        formats,
        formatsStatus,
        formatsError,
        legacyStableId: camera.legacyStableId,
        vendorId: camera.vendorId,
        productId: camera.productId,
        serial: camera.serial,
        physicalPath: camera.physicalPath,
        usbPath: camera.usbPath,
        usbPort: camera.usbPort,
        alternateDevices: camera.alternateDevices ?? [],
      };
    }),
  );
  return requestJson(`${coordinatorUrl}/api/agents/cameras`, token, {
    method: "POST",
    body: JSON.stringify({ cameras }),
  });
}

async function inventoryRefreshRequested(coordinatorUrl: string, token: string) {
  const response = (await requestJson(`${coordinatorUrl}/api/agents/cameras/refresh`, token, { method: "GET" })) as { requested?: boolean };
  return response.requested === true;
}

async function uploadRecord(coordinatorUrl: string, token: string, record: SpoolRecord) {
  const captureMetadata = record.metadataJson ? JSON.parse(record.metadataJson) : {};
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      captureId: record.captureId,
      capturedAt: record.capturedAt,
      captureSourceId: record.captureSourceId,
      originalFilename: path.basename(record.localFilePath),
      expectedSha256: record.sha256,
      expectedByteSize: record.byteSize,
      mimeType: "image/jpeg",
      ...(captureMetadata && typeof captureMetadata === "object" ? captureMetadata : {}),
    }),
  );
  const blob = await openAsBlob(record.localFilePath, { type: "image/jpeg" });
  form.set("image", blob, path.basename(record.localFilePath));
  const response = await fetch(`${coordinatorUrl}/api/agent-ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`ingest returned ${response.status}: ${JSON.stringify(body)}`);
  }
}

async function processUploads(coordinatorUrl: string, token: string, spool: AgentSpool) {
  for (const record of spool.dueUploads()) {
    let active = record;
    try {
      active = await spool.moveFileForState(record, "uploading");
      await uploadRecord(coordinatorUrl, token, active);
      await requestJson(`${coordinatorUrl}/api/agents/jobs/${active.jobId}/complete`, token, {
        method: "POST",
        body: JSON.stringify({ captureId: active.captureId }),
      });
      active = await spool.moveFileForState(active, "acknowledged");
      spool.markAcknowledged(active.jobId);
      log("info", "Capture acknowledged", { jobId: active.jobId, captureId: active.captureId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await spool.moveFileForState(active, "failed").catch(() => undefined);
      spool.markFailed(active.jobId, message);
      await requestJson(`${coordinatorUrl}/api/agents/jobs/${active.jobId}/fail`, token, {
        method: "POST",
        body: JSON.stringify({
          error: message,
          metadata: {
            ...(active.metadataJson ? JSON.parse(active.metadataJson) : {}),
            validationStatus: active.metadataJson ? undefined : "upload-failed",
          },
        }),
      }).catch(() => undefined);
      log("warn", "Capture upload failed", { jobId: active.jobId, error: message });
    }
  }
}

async function pollAndRunJob(coordinatorUrl: string, token: string, spool: AgentSpool) {
  const next = (await requestJson(`${coordinatorUrl}/api/agents/jobs/next`, token, { method: "GET" })) as {
    job?: null | {
      id: string;
      captureSourceId: string;
      assignmentId: string;
      camera: { devicePath: string; stableId: string; name?: string | null };
      settings: {
        width: number;
        height: number;
        inputFormat: string;
        frameRate?: string | null;
        warmupFrames?: number;
        warmupSeconds?: number | null;
        captureAttempts?: number;
        fallback?: { width: number; height: number; inputFormat?: string | null; frameRate?: string | null; attempts?: number } | null;
      };
    };
  };
  if (!next.job) return;

  const captureId = randomUUID();
  await requestJson(`${coordinatorUrl}/api/agents/jobs/${next.job.id}/claim`, token, {
    method: "POST",
    body: JSON.stringify({ captureId }),
  });

  const outputPath = spool.pendingPath(captureId);
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    const result = await captureWithValidation(
      {
        device: next.job.camera.devicePath,
        width: next.job.settings.width,
        height: next.job.settings.height,
        inputFormat: next.job.settings.inputFormat,
      },
      outputPath,
      {
        captureAttempts: next.job.settings.captureAttempts,
        fallback: next.job.settings.fallback,
        spoolRoot: spool.root,
        captureId,
      },
    );
    await spool.recordCaptured({
      jobId: next.job.id,
      captureId,
      assignmentId: next.job.assignmentId,
      captureSourceId: next.job.captureSourceId,
      localFilePath: outputPath,
      capturedAt: result.capturedAt,
      metadata: result.metadata,
    });
    log("info", "Frame captured to durable spool", { jobId: next.job.id, captureId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metadata = error instanceof CaptureFailedError ? error.metadata : undefined;
    await requestJson(`${coordinatorUrl}/api/agents/jobs/${next.job.id}/fail`, token, {
      method: "POST",
      body: JSON.stringify({ error: message, metadata }),
    }).catch(() => undefined);
    log("error", "Capture job failed", { jobId: next.job.id, error: message });
  }
}

type CaptureAttemptMetadata = {
  mode: { width: number; height: number; input_format: string; frame_rate: string | null };
  attempt: number;
  fallback: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: "accepted" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
  byteSize: number | null;
  sha256: string | null;
  rejectedArtifactPath: string | null;
  validationStats?: unknown;
};

class CaptureFailedError extends Error {
  readonly metadata: Record<string, unknown>;

  constructor(message: string, attempts: CaptureAttemptMetadata[]) {
    super(message);
    this.name = "CaptureFailedError";
    const last = attempts.at(-1) ?? null;
    this.metadata = {
      validationStatus: "rejected",
      validationErrorCode: last?.errorCode ?? null,
      attemptCount: attempts.length,
      fallbackUsed: attempts.some((attempt) => attempt.status === "accepted" && attempt.fallback),
      attempts,
    };
  }
}

async function preserveRejectedArtifact(spoolRoot: string, captureId: string, attempt: number, outputPath: string) {
  const file = await stat(outputPath).catch(() => null);
  if (!file || file.size <= 0) return null;
  const date = new Date().toISOString().slice(0, 10);
  const destination = path.join(spoolRoot, "diagnostics", "rejected-captures", date, `${captureId}-attempt-${attempt}.jpg`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(outputPath, destination);
  return destination;
}

async function captureWithValidation(
  primary: { device: string; width: number; height: number; inputFormat: string },
  outputPath: string,
  options: {
    captureAttempts?: number;
    fallback?: { width: number; height: number; inputFormat?: string | null; frameRate?: string | null; attempts?: number } | null;
    spoolRoot: string;
    captureId: string;
  },
) {
  const attempts: CaptureAttemptMetadata[] = [];
  const sequences = [
    { mode: primary, count: Math.max(1, options.captureAttempts ?? 2), fallback: false },
    ...(options.fallback?.width && options.fallback.height
      ? [
          {
            mode: {
              device: primary.device,
              width: options.fallback.width,
              height: options.fallback.height,
              inputFormat: options.fallback.inputFormat ?? primary.inputFormat,
            },
            count: Math.max(1, options.fallback.attempts ?? 1),
            fallback: true,
          },
        ]
      : []),
  ];
  const startedAt = new Date();

  for (const sequence of sequences) {
    for (let index = 0; index < sequence.count; index += 1) {
      const attemptStartedAt = new Date();
      const attempt: CaptureAttemptMetadata = {
        mode: {
          width: sequence.mode.width,
          height: sequence.mode.height,
          input_format: sequence.mode.inputFormat,
          frame_rate: null,
        },
        attempt: attempts.length + 1,
        fallback: sequence.fallback,
        startedAt: attemptStartedAt.toISOString(),
        completedAt: null,
        durationMs: null,
        status: "failed",
        errorCode: null,
        errorMessage: null,
        byteSize: null,
        sha256: null,
        rejectedArtifactPath: null,
      };
      await unlink(outputPath).catch(() => undefined);
      try {
        await runFfmpeg(sequence.mode, outputPath, { warmup: true });
        const validation = await validateImageFile(outputPath, {
          expectedWidth: sequence.mode.width,
          expectedHeight: sequence.mode.height,
          expectedFormat: "jpeg",
        });
        const file = await stat(outputPath);
        attempt.status = "accepted";
        attempt.byteSize = file.size;
        attempt.sha256 = await sha256File(outputPath);
        attempt.validationStats = validation.stats;
        attempt.completedAt = new Date().toISOString();
        attempt.durationMs = Date.now() - attemptStartedAt.getTime();
        attempts.push(attempt);
        return {
          capturedAt: new Date(),
          metadata: {
            captureStartedAt: startedAt.toISOString(),
            frameCapturedAt: attempt.completedAt,
            captureDurationMs: Date.now() - startedAt.getTime(),
            effectiveWidth: sequence.mode.width,
            effectiveHeight: sequence.mode.height,
            effectiveInputFormat: sequence.mode.inputFormat,
            effectiveFrameRate: null,
            attemptCount: attempts.length,
            fallbackUsed: sequence.fallback,
            validationStatus: "accepted",
            validationErrorCode: null,
            attempts,
          },
        };
      } catch (error) {
        attempt.errorCode = error instanceof ImageValidationError ? error.code : "camera-capture-failed";
        attempt.errorMessage = error instanceof Error ? error.message : String(error);
        const file = await stat(outputPath).catch(() => null);
        if (file && file.size > 0) {
          attempt.byteSize = file.size;
          attempt.sha256 = await sha256File(outputPath);
          attempt.rejectedArtifactPath = await preserveRejectedArtifact(options.spoolRoot, options.captureId, attempt.attempt, outputPath);
        }
        if (error instanceof ImageValidationError) {
          attempt.validationStats = error.stats;
        }
        attempt.completedAt = new Date().toISOString();
        attempt.durationMs = Date.now() - attemptStartedAt.getTime();
        attempts.push(attempt);
      }
    }
  }

  await unlink(outputPath).catch(() => undefined);
  const last = attempts.at(-1);
  throw new CaptureFailedError(`camera-fallback-exhausted: ${last?.errorMessage ?? "No capture attempts ran."}`, attempts);
}

async function main() {
  const config = await readNodeConfig();
  if (!config || config.role !== "camera-node" || !config.coordinatorUrl) {
    throw new Error('This machine is not configured as a camera node. Run "plantlab node attach <host>" from the coordinator.');
  }
  const token = process.env.PLANTLAB_NODE_CREDENTIAL;
  if (!token) {
    throw new Error("PLANTLAB_NODE_CREDENTIAL is not set. Check the secure agent env file.");
  }
  const spool = new AgentSpool(config.spoolRoot || "/var/lib/plantlab-agent");
  await spool.init();
  log("info", "PlantLab agent starting", { coordinatorUrl: config.coordinatorUrl, spoolRoot: spool.root });

  try {
    while (!stopping) {
      await postHeartbeat(config.coordinatorUrl, token, config.role).catch((error) => log("warn", "Heartbeat failed", { error: String(error) }));
      await postCameraInventory(config.coordinatorUrl, token).catch((error) => log("warn", "Camera inventory failed", { error: String(error) }));
      if (await inventoryRefreshRequested(config.coordinatorUrl, token).catch(() => false)) {
        await postCameraInventory(config.coordinatorUrl, token).catch((error) => log("warn", "Camera inventory refresh failed", { error: String(error) }));
      }
      await pollAndRunJob(config.coordinatorUrl, token, spool).catch((error) => log("warn", "Job poll failed", { error: String(error) }));
      await processUploads(config.coordinatorUrl, token, spool);
      await spool.cleanupAcknowledged(ACK_RETAIN_MS).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    spool.close();
  }

  log("info", "PlantLab agent stopped");
}

main().catch((error) => {
  log("error", "Fatal PlantLab agent error", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
