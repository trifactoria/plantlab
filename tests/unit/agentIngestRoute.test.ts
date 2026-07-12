import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as postAgentIngest } from "../../src/app/api/agent-ingest/route";
import { resolveCaptureSourcesDataDir, resolveIngestDir } from "../../src/lib/paths.server";
import { prisma } from "../../src/lib/prisma";
import { cleanupTestCaptureSource, createTestCaptureSource } from "./helpers/testCaptureSource";
import { cleanupTestProject, createTestProject } from "./helpers/testProject";

const TOKEN = "vitest-agent-ingest-token";
const ORIGINAL_TOKEN = process.env.PLANTLAB_INGEST_TOKEN;
const ORIGINAL_TOKEN_HASH = process.env.PLANTLAB_INGEST_TOKEN_HASH;
const ORIGINAL_MAX_BYTES = process.env.PLANTLAB_INGEST_MAX_BYTES;

async function realJpegBuffer(width = 60, height = 40, color = { r: 200, g: 40, b: 40 }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

async function realPngBuffer(width = 20, height = 20) {
  return sharp({ create: { width, height, channels: 3, background: { r: 5, g: 5, b: 200 } } }).png().toBuffer();
}

function ingestRequest(opts: {
  metadata?: Record<string, unknown>;
  metadataRaw?: string;
  image?: Buffer;
  imageMimeType?: string;
  skipImage?: boolean;
  skipMetadata?: boolean;
  token?: string | null;
  query?: string;
}) {
  const formData = new FormData();
  if (!opts.skipMetadata) {
    formData.set("metadata", opts.metadataRaw ?? JSON.stringify(opts.metadata ?? {}));
  }
  if (!opts.skipImage && opts.image) {
    formData.set("image", new Blob([new Uint8Array(opts.image)], { type: opts.imageMimeType ?? "image/jpeg" }), "frame.jpg");
  }

  const headers = new Headers();
  if (opts.token !== null) {
    headers.set("authorization", `Bearer ${opts.token ?? TOKEN}`);
  }

  const url = `http://localhost/api/agent-ingest${opts.query ?? ""}`;
  return new Request(url, { method: "POST", headers, body: formData });
}

describe("POST /api/agent-ingest", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanupFns.splice(0)) {
      await fn();
    }
    vi.restoreAllMocks();

    if (ORIGINAL_TOKEN === undefined) delete process.env.PLANTLAB_INGEST_TOKEN;
    else process.env.PLANTLAB_INGEST_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_TOKEN_HASH === undefined) delete process.env.PLANTLAB_INGEST_TOKEN_HASH;
    else process.env.PLANTLAB_INGEST_TOKEN_HASH = ORIGINAL_TOKEN_HASH;
    if (ORIGINAL_MAX_BYTES === undefined) delete process.env.PLANTLAB_INGEST_MAX_BYTES;
    else process.env.PLANTLAB_INGEST_MAX_BYTES = ORIGINAL_MAX_BYTES;
  });

  async function makeSource(overrides: Parameters<typeof createTestCaptureSource>[1] = {}) {
    const source = await createTestCaptureSource(prisma, { width: 200, height: 100, ...overrides });
    cleanupFns.push(() => cleanupTestCaptureSource(prisma, source.id, source.captureDirectory));
    return source;
  }

  function baseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      captureId: `capture-${Math.random().toString(16).slice(2)}`,
      capturedAt: "2026-07-11T12:00:00.000Z",
      originalFilename: "frame.jpg",
      mimeType: "image/jpeg",
      ...overrides,
    };
  }

  async function metadataWithChecksum(image: Buffer, overrides: Record<string, unknown> = {}) {
    return baseMetadata({
      expectedSha256: createHash("sha256").update(image).digest("hex"),
      expectedByteSize: image.length,
      ...overrides,
    });
  }

  it("rejects an unauthenticated request with 401", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const image = await realJpegBuffer();
    const source = await makeSource();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    const response = await postAgentIngest(ingestRequest({ metadata, image, token: null }));
    expect(response.status).toBe(401);
  });

  it("rejects a request with an invalid token with 401", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const image = await realJpegBuffer();
    const source = await makeSource();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    const response = await postAgentIngest(ingestRequest({ metadata, image, token: "wrong-token" }));
    expect(response.status).toBe(401);
  });

  it("rejects malformed metadata with 400", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const image = await realJpegBuffer();

    const response = await postAgentIngest(ingestRequest({ metadataRaw: "{not valid json", image }));
    expect(response.status).toBe(400);
  });

  it("rejects a request naming an unknown capture source with 404", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const image = await realJpegBuffer();
    const metadata = await metadataWithChecksum(image, { captureSourceId: "does-not-exist" });

    const response = await postAgentIngest(ingestRequest({ metadata, image }));
    expect(response.status).toBe(404);
  });

  it("accepts a valid JPEG upload, storing it atomically and creating a durable SourceCapture (201)", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    const response = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.status).toBe("created");
    expect(payload.captureId).toBe(metadata.captureId);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row).not.toBeNull();
    expect(row?.sha256).toBe(metadata.expectedSha256);
    expect(row?.byteSize).toBe(metadata.expectedByteSize);
    expect(row?.mimeType).toBe("image/jpeg");
    expect(row?.ingestSource).toBe("http-agent-ingest");
    expect(row?.storageKey).toBe(path.join(source.id, "2026", "07", `${metadata.captureId}.jpg`));

    const absolutePath = path.join(resolveCaptureSourcesDataDir(), row!.storageKey!);
    expect(row?.originalPath).toBe(absolutePath);
    const onDisk = await readFile(absolutePath);
    expect(onDisk.equals(image)).toBe(true);

    // The ingest staging directory must not retain the file after success.
    const stagingEntries = await readdir(resolveIngestDir()).catch(() => []);
    expect(stagingEntries.filter((f) => f.endsWith(".partial"))).toHaveLength(0);
  });

  it("accepts a valid PNG upload", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realPngBuffer();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id, mimeType: "image/png" });

    const response = await postAgentIngest(ingestRequest({ metadata, image, imageMimeType: "image/png", query: "?mode=store-only" }));
    expect(response.status).toBe(201);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row?.storageKey?.endsWith(".png")).toBe(true);
  });

  it("rejects an invalid (non-image) upload with 400 and leaves no SourceCapture or canonical file", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const notAnImage = Buffer.from("definitely not an image");
    const metadata = await metadataWithChecksum(notAnImage, { captureSourceId: source.id });

    const response = await postAgentIngest(ingestRequest({ metadata, image: notAnImage }));
    expect(response.status).toBe(400);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row).toBeNull();
  });

  it("rejects an upload exceeding the configured max size with 413", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    process.env.PLANTLAB_INGEST_MAX_BYTES = "10";
    const source = await makeSource();
    const image = await realJpegBuffer();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    const response = await postAgentIngest(ingestRequest({ metadata, image }));
    expect(response.status).toBe(413);

    const stagingEntries = await readdir(resolveIngestDir()).catch(() => []);
    expect(stagingEntries.filter((f) => f.endsWith(".partial"))).toHaveLength(0);
  });

  it("rejects a checksum mismatch with 400", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer();
    const metadata = baseMetadata({
      captureSourceId: source.id,
      expectedSha256: "a".repeat(64),
      expectedByteSize: image.length,
    });

    const response = await postAgentIngest(ingestRequest({ metadata, image }));
    expect(response.status).toBe(400);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row).toBeNull();
  });

  it("rejects a byte-size mismatch with 400", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer();
    const metadata = baseMetadata({
      captureSourceId: source.id,
      expectedSha256: createHash("sha256").update(image).digest("hex"),
      expectedByteSize: image.length + 5,
    });

    const response = await postAgentIngest(ingestRequest({ metadata, image }));
    expect(response.status).toBe(400);
  });

  it("first upload returns 201; an identical retry of the same captureId returns 200 without creating a duplicate", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    const first = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(first.status).toBe(201);

    const retry = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(retry.status).toBe(200);
    const retryPayload = await retry.json();
    expect(retryPayload.status).toBe("already-exists");

    const rows = await prisma.sourceCapture.findMany({ where: { captureId: metadata.captureId as string } });
    expect(rows).toHaveLength(1);
  });

  it("a retry with the same captureId but different content is rejected with 409, preserving the original", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer();
    const differentImage = await realJpegBuffer(60, 40, { r: 10, g: 250, b: 10 });
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });
    const conflictingMetadata = await metadataWithChecksum(differentImage, {
      captureSourceId: source.id,
      captureId: metadata.captureId,
    });

    const first = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(first.status).toBe(201);
    const firstPayload = await first.json();

    const conflict = await postAgentIngest(ingestRequest({ metadata: conflictingMetadata, image: differentImage, query: "?mode=store-only" }));
    expect(conflict.status).toBe(409);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row?.id).toBe(firstPayload.sourceCaptureId);
    expect(row?.sha256).toBe(metadata.expectedSha256);

    // The originally-stored file is untouched by the rejected conflicting retry.
    const absolutePath = path.join(resolveCaptureSourcesDataDir(), row!.storageKey!);
    const onDisk = await readFile(absolutePath);
    expect(onDisk.equals(image)).toBe(true);
  });

  it("cleans up the canonical file when the database write fails after durable placement", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer();
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    vi.spyOn(prisma.sourceCapture, "create").mockRejectedValueOnce(new Error("simulated database failure"));

    const response = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(response.status).toBe(500);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row).toBeNull();

    const expectedPath = path.join(
      resolveCaptureSourcesDataDir(),
      source.id,
      "2026",
      "07",
      `${metadata.captureId}.jpg`,
    );
    await expect(stat(expectedPath)).rejects.toThrow();
  });

  it("leaves no canonical record when the upload stream is interrupted mid-transfer", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const image = await realJpegBuffer(400, 400);
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id });

    const formData = new FormData();
    formData.set("metadata", JSON.stringify(metadata));
    formData.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "frame.jpg");
    const fullRequest = new Request("http://localhost/x", { method: "POST", body: formData });
    const realBody = fullRequest.body!;
    const reader = realBody.getReader();

    const truncatedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("simulated client disconnect mid-upload"));
          return;
        }
        // Forward only a small prefix of each chunk, then abort - simulates
        // a connection dropping partway through the image bytes.
        controller.enqueue(value.subarray(0, Math.min(10, value.length)));
        controller.error(new Error("simulated client disconnect mid-upload"));
      },
    });

    const headers = new Headers(fullRequest.headers);
    headers.set("authorization", `Bearer ${TOKEN}`);
    const brokenRequest = new Request("http://localhost/api/agent-ingest", {
      method: "POST",
      headers,
      body: truncatedStream,
      // @ts-expect-error - required by undici for streaming request bodies constructed manually.
      duplex: "half",
    });

    const response = await postAgentIngest(brokenRequest);
    expect(response.status).toBeGreaterThanOrEqual(400);

    const row = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId as string } });
    expect(row).toBeNull();

    const stagingEntries = await readdir(resolveIngestDir()).catch(() => []);
    expect(stagingEntries.filter((f) => f.endsWith(".partial"))).toHaveLength(0);
  });

  it("default mode runs viewport fan-out once, and a retried upload does not duplicate the derived project photo", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null });
    cleanupFns.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));

    await prisma.projectViewport.create({
      data: {
        projectId: project.id,
        captureSourceId: source.id,
        cropX: 0,
        cropY: 0,
        cropWidth: 1,
        cropHeight: 1,
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        active: true,
      },
    });

    const image = await realJpegBuffer(200, 100);
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id, capturedAt: "2026-07-11T15:00:00.000Z" });

    const first = await postAgentIngest(ingestRequest({ metadata, image }));
    expect(first.status).toBe(201);
    const firstPayload = await first.json();
    expect(firstPayload.fanOutTriggered).toBe(true);

    const photosAfterFirst = await prisma.photo.count({ where: { projectId: project.id, sourceCaptureId: firstPayload.sourceCaptureId } });
    expect(photosAfterFirst).toBe(1);

    const retry = await postAgentIngest(ingestRequest({ metadata, image }));
    expect(retry.status).toBe(200);

    const photosAfterRetry = await prisma.photo.count({ where: { projectId: project.id, sourceCaptureId: firstPayload.sourceCaptureId } });
    expect(photosAfterRetry).toBe(1);
  });

  it("?mode=store-only stores the capture without running viewport fan-out", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    const project = await createTestProject(prisma, { captureEnabled: false, cameraDevice: null });
    cleanupFns.push(() => cleanupTestProject(prisma, project.id, project.localPhotoDirectory));

    await prisma.projectViewport.create({
      data: {
        projectId: project.id,
        captureSourceId: source.id,
        cropX: 0,
        cropY: 0,
        cropWidth: 1,
        cropHeight: 1,
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        active: true,
      },
    });

    const image = await realJpegBuffer(200, 100);
    const metadata = await metadataWithChecksum(image, { captureSourceId: source.id, capturedAt: "2026-07-11T16:00:00.000Z" });

    const response = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.fanOutTriggered).toBe(false);

    const photoCount = await prisma.photo.count({ where: { projectId: project.id, sourceCaptureId: payload.sourceCaptureId } });
    expect(photoCount).toBe(0);
  });

  it("resolves the capture source via cameraStableId when captureSourceId is not supplied", async () => {
    process.env.PLANTLAB_INGEST_TOKEN = TOKEN;
    const source = await makeSource();
    await prisma.captureSource.update({ where: { id: source.id }, data: { cameraStableId: "stable-agent-test" } });

    const image = await realJpegBuffer();
    const metadata = await metadataWithChecksum(image, { cameraStableId: "stable-agent-test" });

    const response = await postAgentIngest(ingestRequest({ metadata, image, query: "?mode=store-only" }));
    expect(response.status).toBe(201);
  });
});
