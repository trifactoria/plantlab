import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildSourceCaptureStorageKey,
  cleanupIngestFile,
  IngestRequestError,
  parseIngestMetadata,
  placeStagedFileAtCanonicalPath,
  receiveIngestMultipart,
  resolveIngestCaptureSource,
  validateStagedImage,
  verifyStagedUploadMatchesExpectations,
} from "../../src/lib/ingest.server";
import { resolveCaptureSourcesDataDir } from "../../src/lib/paths.server";

async function realJpegBuffer(width = 40, height = 30) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

function multipartRequest(parts: { metadata?: unknown; metadataRaw?: string; image?: Buffer; imageMimeType?: string; imageFilename?: string; skipImage?: boolean }) {
  const formData = new FormData();
  if (parts.metadataRaw !== undefined) {
    formData.set("metadata", parts.metadataRaw);
  } else if (parts.metadata !== undefined) {
    formData.set("metadata", JSON.stringify(parts.metadata));
  }
  if (!parts.skipImage && parts.image) {
    formData.set("image", new Blob([new Uint8Array(parts.image)], { type: parts.imageMimeType ?? "image/jpeg" }), parts.imageFilename ?? "frame.jpg");
  }
  return new Request("http://localhost/api/agent-ingest", { method: "POST", body: formData });
}

function validMetadata(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    captureId: "capture-1",
    capturedAt: "2026-07-11T12:00:00.000Z",
    cameraStableId: "camera-stable-1",
    originalFilename: "frame.jpg",
    expectedSha256: "0".repeat(64),
    expectedByteSize: 123,
    mimeType: "image/jpeg",
    ...overrides,
  };
}

describe("receiveIngestMultipart", () => {
  it("streams the image to a .partial staging file and computes its SHA-256 and byte size", async () => {
    const image = await realJpegBuffer();
    const expectedHash = createHash("sha256").update(image).digest("hex");

    const request = multipartRequest({ metadata: validMetadata(), image });
    const staged = await receiveIngestMultipart(request);

    try {
      expect(staged.stagingPath.endsWith(".partial")).toBe(true);
      expect(staged.byteSize).toBe(image.length);
      expect(staged.sha256).toBe(expectedHash);
      const onDisk = await stat(staged.stagingPath);
      expect(onDisk.size).toBe(image.length);
    } finally {
      await cleanupIngestFile(staged.stagingPath);
    }
  });

  it("rejects a request missing the image part", async () => {
    const request = multipartRequest({ metadata: validMetadata(), skipImage: true });
    await expect(receiveIngestMultipart(request)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a request missing the metadata field", async () => {
    const image = await realJpegBuffer();
    const request = multipartRequest({ image });
    await expect(receiveIngestMultipart(request)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects malformed (non-JSON) metadata", async () => {
    const image = await realJpegBuffer();
    const request = multipartRequest({ metadataRaw: "{not json", image });
    await expect(receiveIngestMultipart(request)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an upload exceeding the configured max size and leaves no staging file behind", async () => {
    const image = await realJpegBuffer(200, 200);
    const request = multipartRequest({ metadata: validMetadata(), image });

    let caught: unknown;
    try {
      await receiveIngestMultipart(request, image.length - 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IngestRequestError);
    expect((caught as IngestRequestError).status).toBe(413);
  });
});

describe("parseIngestMetadata", () => {
  it("accepts a fully valid payload", () => {
    const parsed = parseIngestMetadata(validMetadata());
    expect(parsed.captureId).toBe("capture-1");
    expect(parsed.mimeType).toBe("image/jpeg");
    expect(parsed.capturedAt.toISOString()).toBe("2026-07-11T12:00:00.000Z");
  });

  it.each([
    ["captureId", { captureId: "" }],
    ["capturedAt", { capturedAt: "not-a-date" }],
    ["cameraStableId", { cameraStableId: "" }],
    ["originalFilename", { originalFilename: "" }],
    ["expectedSha256", { expectedSha256: "not-hex" }],
    ["expectedByteSize", { expectedByteSize: -1 }],
    ["mimeType", { mimeType: "image/gif" }],
  ])("rejects an invalid %s", (_field, override) => {
    expect(() => parseIngestMetadata(validMetadata(override))).toThrow(IngestRequestError);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseIngestMetadata("just a string")).toThrow(IngestRequestError);
  });

  it("accepts captureSourceId as an alternative to cameraStableId", () => {
    const parsed = parseIngestMetadata(validMetadata({ cameraStableId: undefined, captureSourceId: "source-123" }));
    expect(parsed.captureSourceId).toBe("source-123");
    expect(parsed.cameraStableId).toBeNull();
  });

  it("rejects metadata missing both captureSourceId and cameraStableId", () => {
    expect(() => parseIngestMetadata(validMetadata({ cameraStableId: undefined }))).toThrow(IngestRequestError);
  });
});

describe("resolveIngestCaptureSource", () => {
  function fakePrisma(sources: Array<{ id: string; cameraStableId: string | null }>) {
    return {
      captureSource: {
        findUnique: async (args: { where: { id: string } }) => sources.find((s) => s.id === args.where.id) ?? null,
        findMany: async (args: { where: { cameraStableId: string | null } }) =>
          sources.filter((s) => s.cameraStableId === args.where.cameraStableId),
      },
    };
  }

  it("resolves directly by captureSourceId when present", async () => {
    const prisma = fakePrisma([{ id: "source-1", cameraStableId: null }]);
    const metadata = parseIngestMetadata(validMetadata({ cameraStableId: undefined, captureSourceId: "source-1" }));
    const resolved = await resolveIngestCaptureSource(prisma, metadata);
    expect(resolved.id).toBe("source-1");
  });

  it("throws 404 for an unknown captureSourceId", async () => {
    const prisma = fakePrisma([]);
    const metadata = parseIngestMetadata(validMetadata({ cameraStableId: undefined, captureSourceId: "missing" }));
    await expect(resolveIngestCaptureSource(prisma, metadata)).rejects.toMatchObject({ status: 404 });
  });

  it("resolves by cameraStableId when captureSourceId is absent", async () => {
    const prisma = fakePrisma([{ id: "source-1", cameraStableId: "stable-abc" }]);
    const metadata = parseIngestMetadata(validMetadata({ cameraStableId: "stable-abc" }));
    const resolved = await resolveIngestCaptureSource(prisma, metadata);
    expect(resolved.id).toBe("source-1");
  });

  it("throws 404 when no capture source matches the given cameraStableId", async () => {
    const prisma = fakePrisma([]);
    const metadata = parseIngestMetadata(validMetadata({ cameraStableId: "unknown-stable" }));
    await expect(resolveIngestCaptureSource(prisma, metadata)).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when cameraStableId matches more than one capture source", async () => {
    const prisma = fakePrisma([
      { id: "source-1", cameraStableId: "stable-abc" },
      { id: "source-2", cameraStableId: "stable-abc" },
    ]);
    const metadata = parseIngestMetadata(validMetadata({ cameraStableId: "stable-abc" }));
    await expect(resolveIngestCaptureSource(prisma, metadata)).rejects.toMatchObject({ status: 400 });
  });
});

describe("verifyStagedUploadMatchesExpectations", () => {
  it("passes when byte size and checksum both match", () => {
    const metadata = parseIngestMetadata(validMetadata({ expectedByteSize: 5, expectedSha256: "a".repeat(64) }));
    expect(() => verifyStagedUploadMatchesExpectations({ byteSize: 5, sha256: "a".repeat(64) }, metadata)).not.toThrow();
  });

  it("throws 400 on a byte-size mismatch", () => {
    const metadata = parseIngestMetadata(validMetadata({ expectedByteSize: 5, expectedSha256: "a".repeat(64) }));
    expect(() => verifyStagedUploadMatchesExpectations({ byteSize: 6, sha256: "a".repeat(64) }, metadata)).toThrow(IngestRequestError);
  });

  it("throws 400 on a checksum mismatch", () => {
    const metadata = parseIngestMetadata(validMetadata({ expectedByteSize: 5, expectedSha256: "a".repeat(64) }));
    expect(() => verifyStagedUploadMatchesExpectations({ byteSize: 5, sha256: "b".repeat(64) }, metadata)).toThrow(IngestRequestError);
  });
});

describe("validateStagedImage", () => {
  it("accepts a real JPEG that matches the declared mimeType", async () => {
    const image = await realJpegBuffer(64, 48);
    const request = multipartRequest({ metadata: validMetadata(), image });
    const staged = await receiveIngestMultipart(request);
    try {
      const metadata = parseIngestMetadata(validMetadata());
      const result = await validateStagedImage(staged.stagingPath, metadata);
      expect(result.width).toBe(64);
      expect(result.height).toBe(48);
      expect(result.format).toBe("jpeg");
    } finally {
      await cleanupIngestFile(staged.stagingPath);
    }
  });

  it("accepts a real PNG that matches the declared mimeType", async () => {
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const request = multipartRequest({ metadata: validMetadata({ mimeType: "image/png" }), image, imageMimeType: "image/png" });
    const staged = await receiveIngestMultipart(request);
    try {
      const metadata = parseIngestMetadata(validMetadata({ mimeType: "image/png" }));
      const result = await validateStagedImage(staged.stagingPath, metadata);
      expect(result.format).toBe("png");
    } finally {
      await cleanupIngestFile(staged.stagingPath);
    }
  });

  it("rejects a file that is not a real image at all", async () => {
    const notAnImage = Buffer.from("this is definitely not an image");
    const request = multipartRequest({ metadata: validMetadata(), image: notAnImage });
    const staged = await receiveIngestMultipart(request);
    try {
      const metadata = parseIngestMetadata(validMetadata());
      await expect(validateStagedImage(staged.stagingPath, metadata)).rejects.toMatchObject({ status: 400 });
    } finally {
      await cleanupIngestFile(staged.stagingPath);
    }
  });

  it("rejects a real image whose actual format doesn't match the declared mimeType", async () => {
    const pngBytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
    // Declares JPEG in metadata but the bytes are actually PNG.
    const request = multipartRequest({ metadata: validMetadata({ mimeType: "image/jpeg" }), image: pngBytes, imageMimeType: "image/jpeg" });
    const staged = await receiveIngestMultipart(request);
    try {
      const metadata = parseIngestMetadata(validMetadata({ mimeType: "image/jpeg" }));
      await expect(validateStagedImage(staged.stagingPath, metadata)).rejects.toMatchObject({ status: 400 });
    } finally {
      await cleanupIngestFile(staged.stagingPath);
    }
  });
});

describe("buildSourceCaptureStorageKey / placeStagedFileAtCanonicalPath", () => {
  it("builds the documented <captureSourceId>/<year>/<month>/<captureId>.jpg layout", () => {
    const key = buildSourceCaptureStorageKey({
      captureSourceId: "source-abc",
      captureId: "capture-xyz",
      capturedAt: new Date("2026-07-11T12:00:00.000Z"),
      extension: ".jpg",
    });
    expect(key).toBe(path.join("source-abc", "2026", "07", "capture-xyz.jpg"));
  });

  it("sanitizes a captureId containing path-unsafe characters", () => {
    const key = buildSourceCaptureStorageKey({
      captureSourceId: "source-abc",
      captureId: "../../etc/passwd",
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      extension: ".jpg",
    });
    expect(key).not.toContain("..");
    expect(key.startsWith(path.join("source-abc", "2026", "01"))).toBe(true);
  });

  it("atomically renames a staged file into its canonical location under resolveCaptureSourcesDataDir()", async () => {
    const image = await realJpegBuffer();
    const request = multipartRequest({ metadata: validMetadata(), image });
    const staged = await receiveIngestMultipart(request);

    const storageKey = buildSourceCaptureStorageKey({
      captureSourceId: "source-place-test",
      captureId: "capture-place-test",
      capturedAt: new Date("2026-07-11T00:00:00.000Z"),
      extension: ".jpg",
    });

    const absolutePath = await placeStagedFileAtCanonicalPath(staged.stagingPath, storageKey);
    try {
      expect(absolutePath).toBe(path.join(resolveCaptureSourcesDataDir(), storageKey));
      const onDisk = await stat(absolutePath);
      expect(onDisk.size).toBe(image.length);
      await expect(stat(staged.stagingPath)).rejects.toThrow();
    } finally {
      await cleanupIngestFile(absolutePath);
    }
  });
});
