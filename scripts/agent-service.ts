import { openAsBlob } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import packageJson from "../package.json";
import { runFfmpeg } from "../src/lib/camera";
import { readNodeConfig } from "../src/lib/operations/config";
import { AgentSpool, type SpoolRecord } from "../src/lib/operations/agentSpool";
import { discoverLocalCameras, listCameraFormats } from "../src/lib/v4l2";

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
    }),
  });
}

async function postCameraInventory(coordinatorUrl: string, token: string) {
  const cameras = await Promise.all(
    (await discoverLocalCameras()).map(async (camera) => ({
      stableId: camera.stableId ?? camera.device,
      devicePath: camera.device,
      name: camera.name,
      available: camera.supportsCapture,
      formats: await listCameraFormats(camera.device).catch(() => []),
    })),
  );
  return requestJson(`${coordinatorUrl}/api/agents/cameras`, token, {
    method: "POST",
    body: JSON.stringify({ cameras }),
  });
}

async function uploadRecord(coordinatorUrl: string, token: string, record: SpoolRecord) {
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
        body: JSON.stringify({ error: message }),
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
      settings: { width: number; height: number; inputFormat: string };
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
    await runFfmpeg(
      {
        device: next.job.camera.devicePath,
        width: next.job.settings.width,
        height: next.job.settings.height,
        inputFormat: next.job.settings.inputFormat,
      },
      outputPath,
      { warmup: true },
    );
    await spool.recordCaptured({
      jobId: next.job.id,
      captureId,
      assignmentId: next.job.assignmentId,
      captureSourceId: next.job.captureSourceId,
      localFilePath: outputPath,
      capturedAt: new Date(),
    });
    log("info", "Frame captured to durable spool", { jobId: next.job.id, captureId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await requestJson(`${coordinatorUrl}/api/agents/jobs/${next.job.id}/fail`, token, {
      method: "POST",
      body: JSON.stringify({ error: message }),
    }).catch(() => undefined);
    log("error", "Capture job failed", { jobId: next.job.id, error: message });
  }
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
