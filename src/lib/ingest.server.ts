import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import Busboy from "busboy";
import sharp from "sharp";
import { resolveCaptureSourcesDataDir, resolveIngestDir } from "./paths.server";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/ingest.server.ts touches the filesystem - it must never be imported from a Client Component or run in a browser.",
  );
}

/** Thrown for any client-caused ingest failure; `status` is the HTTP status the route should return. */
export class IngestRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "IngestRequestError";
    this.status = status;
  }
}

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB - comfortably above one full-resolution JPEG frame.

/** PLANTLAB_INGEST_MAX_BYTES overrides the default per-upload size limit. */
export function resolveMaxUploadBytes(): number {
  const override = process.env.PLANTLAB_INGEST_MAX_BYTES;
  const parsed = override ? Number.parseInt(override, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

export const SUPPORTED_INGEST_MIME_TYPES = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
]);

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export type ParsedIngestMetadata = {
  captureId: string;
  capturedAt: Date;
  /** Canonical CaptureSource.id, when the agent already knows it - preferred over cameraStableId when both are present. */
  captureSourceId: string | null;
  /** Fallback source identifier resolved by the route via a CaptureSource.cameraStableId lookup. At least one of captureSourceId/cameraStableId is required. */
  cameraStableId: string | null;
  originalFilename: string;
  expectedSha256: string;
  expectedByteSize: number;
  mimeType: string;
};

export type StagedUpload = {
  metadataRaw: unknown;
  stagingPath: string;
  byteSize: number;
  sha256: string;
};

/**
 * Streams a multipart/form-data agent-ingest request (a "metadata" JSON
 * field plus an "image" file field, in either order) to a `.partial` file
 * under resolveIngestDir(), computing its SHA-256 while streaming.
 *
 * The complete image is never buffered in memory: bytes flow straight from
 * the request body through Busboy into a filesystem write stream, and the
 * running hash is updated per-chunk. The configured max-upload size is
 * enforced by Busboy DURING streaming (via `limits.fileSize`), so an
 * oversized upload is aborted as soon as the limit is crossed rather than
 * after the whole thing has already landed on disk.
 *
 * On any failure (malformed multipart, oversized file, disconnected
 * client, missing parts) the partial file is removed before this rejects -
 * callers only need to clean up after a *successful* stage once they're
 * done validating/placing it.
 */
export async function receiveIngestMultipart(request: Request, maxBytes = resolveMaxUploadBytes()): Promise<StagedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new IngestRequestError('Request must be multipart/form-data with "metadata" and "image" parts.', 400);
  }
  if (!request.body) {
    throw new IngestRequestError("Request has no body.", 400);
  }

  await mkdir(resolveIngestDir(), { recursive: true });
  const stagingPath = path.join(resolveIngestDir(), `${randomUUID()}.partial`);

  let metadataRaw: unknown;
  let sawImageField = false;
  let byteSize = 0;
  const hash = createHash("sha256");
  const sourceStream = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let writeFinished = false;
      let busboyClosed = false;
      let limitExceeded = false;
      // fs.createWriteStream() opens its file descriptor asynchronously -
      // destroy()ing it does not guarantee the file has actually been
      // created (or its creation aborted) by the time destroy() returns.
      // Every path that settles this promise with an error must wait for
      // the write stream's own "close" event (which Node's fs streams
      // guarantee to emit only after any in-flight open() has resolved and
      // the fd is fully closed) before resolving/rejecting - otherwise the
      // outer caller's rm(stagingPath) can run before the file has even
      // been created, silently no-op, and then a moment later the deferred
      // open() finishes and creates an orphaned .partial file nothing ever
      // cleans up. Confirmed empirically: without this, ~10% of oversized
      // uploads left a stray .partial file behind.
      let writeStream: ReturnType<typeof createWriteStream> | null = null;
      let writeStreamClosed = false;

      const settle = (error?: Error) => {
        settled = true;
        sourceStream.destroy();
        if (error) reject(error);
        else resolve();
      };

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        sourceStream.destroy();

        // Always wait for "close" if the write stream hasn't emitted it yet
        // - including when it's already mid-destroy on its own (e.g. its
        // own "error" handler called finish()), not just when we are the
        // one initiating the destroy here.
        if (writeStream && !writeStreamClosed) {
          writeStream.once("close", () => settle(error));
          if (!writeStream.destroyed) {
            writeStream.destroy();
          }
          return;
        }

        settle(error);
      };

      const maybeResolve = () => {
        if (writeFinished && busboyClosed && sawImageField && !settled) {
          finish();
        }
      };

      const bb = Busboy({
        headers: { "content-type": contentType },
        limits: { files: 1, fileSize: maxBytes },
      });

      bb.on("field", (name, value) => {
        // Busboy can synchronously emit several part events (a "field" and
        // the following "file") while processing a single buffered chunk
        // of the request body - a rejection decided by an earlier part in
        // that same chunk must not let a later part in it still act (e.g.
        // start writing a file) after we've already settled.
        if (settled || name !== "metadata") return;
        try {
          metadataRaw = JSON.parse(value);
        } catch {
          finish(new IngestRequestError('The "metadata" field must be valid JSON.', 400));
        }
      });

      bb.on("file", (name, fileStream) => {
        if (settled || name !== "image" || sawImageField) {
          fileStream.resume();
          return;
        }
        sawImageField = true;

        writeStream = createWriteStream(stagingPath);
        writeStream.on("close", () => {
          writeStreamClosed = true;
        });

        fileStream.on("limit", () => {
          limitExceeded = true;
          fileStream.unpipe(writeStream!);
          finish(new IngestRequestError(`Upload exceeds the maximum allowed size of ${maxBytes} bytes.`, 413));
        });
        fileStream.on("data", (chunk: Buffer) => {
          if (limitExceeded) return;
          byteSize += chunk.length;
          hash.update(chunk);
        });
        fileStream.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
        writeStream.on("error", (error) => finish(error));
        writeStream.on("finish", () => {
          writeFinished = true;
          maybeResolve();
        });

        fileStream.pipe(writeStream);
      });

      bb.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      // Readable.fromWeb() surfaces an errored/aborted request body (e.g. a
      // disconnected client) as an "error" event on sourceStream itself -
      // without this listener, an unhandled EventEmitter "error" event
      // becomes an uncaught exception instead of a clean rejection here.
      sourceStream.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      bb.on("close", () => {
        busboyClosed = true;
        if (!sawImageField) {
          finish(new IngestRequestError('Request is missing the required "image" part.', 400));
          return;
        }
        maybeResolve();
      });

      sourceStream.pipe(bb);
    });
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }

  if (metadataRaw === undefined) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw new IngestRequestError('Request is missing the required "metadata" field.', 400);
  }

  return { metadataRaw, stagingPath, byteSize, sha256: hash.digest("hex") };
}

/** Validates the shape of the "metadata" field's parsed JSON. Throws IngestRequestError(400) on any problem. */
export function parseIngestMetadata(raw: unknown): ParsedIngestMetadata {
  if (!raw || typeof raw !== "object") {
    throw new IngestRequestError('The "metadata" field must be a JSON object.', 400);
  }
  const value = raw as Record<string, unknown>;

  const captureId = typeof value.captureId === "string" ? value.captureId.trim() : "";
  if (!captureId) {
    throw new IngestRequestError("metadata.captureId is required.", 400);
  }

  const capturedAt = typeof value.capturedAt === "string" ? new Date(value.capturedAt) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) {
    throw new IngestRequestError("metadata.capturedAt must be a valid ISO date string.", 400);
  }

  const captureSourceId = typeof value.captureSourceId === "string" && value.captureSourceId.trim() ? value.captureSourceId.trim() : null;
  const cameraStableId = typeof value.cameraStableId === "string" && value.cameraStableId.trim() ? value.cameraStableId.trim() : null;
  if (!captureSourceId && !cameraStableId) {
    throw new IngestRequestError("metadata must include either captureSourceId or cameraStableId.", 400);
  }

  const originalFilename = typeof value.originalFilename === "string" ? value.originalFilename.trim() : "";
  if (!originalFilename) {
    throw new IngestRequestError("metadata.originalFilename is required.", 400);
  }

  const expectedSha256 = typeof value.expectedSha256 === "string" ? value.expectedSha256.trim().toLowerCase() : "";
  if (!SHA256_HEX_PATTERN.test(expectedSha256)) {
    throw new IngestRequestError("metadata.expectedSha256 must be a 64-character hex SHA-256 digest.", 400);
  }

  const expectedByteSize = typeof value.expectedByteSize === "number" ? value.expectedByteSize : Number(value.expectedByteSize);
  if (!Number.isInteger(expectedByteSize) || expectedByteSize <= 0) {
    throw new IngestRequestError("metadata.expectedByteSize must be a positive integer.", 400);
  }

  const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim().toLowerCase() : "";
  if (!SUPPORTED_INGEST_MIME_TYPES.has(mimeType)) {
    throw new IngestRequestError(
      `metadata.mimeType must be one of: ${Array.from(SUPPORTED_INGEST_MIME_TYPES.keys()).join(", ")}.`,
      400,
    );
  }

  return { captureId, capturedAt, captureSourceId, cameraStableId, originalFilename, expectedSha256, expectedByteSize, mimeType };
}

/**
 * Resolves a ParsedIngestMetadata's captureSourceId/cameraStableId to a
 * concrete CaptureSource row. captureSourceId (a direct DB id) is checked
 * first when present; cameraStableId is a free-form, NOT database-unique
 * field (see prisma/schema.prisma), so a lookup by it can legitimately
 * match zero or more than one row - both are treated as errors rather than
 * silently picking one.
 */
export type IngestCaptureSourceLookup = {
  captureSource: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string } | null>;
    findMany: (args: { where: { cameraStableId: string | null } }) => Promise<Array<{ id: string }>>;
  };
};

export async function resolveIngestCaptureSource(
  prisma: IngestCaptureSourceLookup,
  metadata: Pick<ParsedIngestMetadata, "captureSourceId" | "cameraStableId">,
): Promise<{ id: string }> {
  if (metadata.captureSourceId) {
    const source = await prisma.captureSource.findUnique({ where: { id: metadata.captureSourceId } });
    if (!source) {
      throw new IngestRequestError(`No capture source exists with id "${metadata.captureSourceId}".`, 404);
    }
    return source;
  }

  const matches = await prisma.captureSource.findMany({ where: { cameraStableId: metadata.cameraStableId } });
  if (matches.length === 0) {
    throw new IngestRequestError(`No capture source is registered with cameraStableId "${metadata.cameraStableId}".`, 404);
  }
  if (matches.length > 1) {
    throw new IngestRequestError(
      `cameraStableId "${metadata.cameraStableId}" matches more than one capture source - use captureSourceId instead.`,
      400,
    );
  }
  return matches[0];
}

/** Confirms what actually streamed to disk matches what the agent claimed it was sending. */
export function verifyStagedUploadMatchesExpectations(staged: Pick<StagedUpload, "byteSize" | "sha256">, metadata: ParsedIngestMetadata): void {
  if (staged.byteSize !== metadata.expectedByteSize) {
    throw new IngestRequestError(
      `Uploaded byte size (${staged.byteSize}) does not match metadata.expectedByteSize (${metadata.expectedByteSize}).`,
      400,
    );
  }

  if (staged.sha256.toLowerCase() !== metadata.expectedSha256) {
    throw new IngestRequestError("Uploaded file's SHA-256 checksum does not match metadata.expectedSha256.", 400);
  }
}

export type ValidatedImage = { width: number; height: number; format: string };

/**
 * Confirms the staged file actually decodes as an image and matches its
 * declared mimeType, reading directly from the staged file path (Sharp
 * streams/bounds its own decode buffer) rather than loading it into a JS
 * Buffer first.
 */
export async function validateStagedImage(stagingPath: string, metadata: ParsedIngestMetadata): Promise<ValidatedImage> {
  let imageMetadata;
  try {
    imageMetadata = await sharp(stagingPath).metadata();
  } catch (error) {
    throw new IngestRequestError(
      `Uploaded file is not a valid or supported image: ${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }

  const { width, height, format } = imageMetadata;
  if (!width || !height || !format) {
    throw new IngestRequestError("Could not read the uploaded image's dimensions.", 400);
  }

  const expectedFormat = metadata.mimeType === "image/png" ? "png" : "jpeg";
  if (format !== expectedFormat) {
    throw new IngestRequestError(
      `Uploaded file's actual image format (${format}) does not match declared metadata.mimeType (${metadata.mimeType}).`,
      400,
    );
  }

  return { width, height, format };
}

/**
 * Canonical relative storage key for a remotely-ingested source capture,
 * relative to resolveCaptureSourcesDataDir() - NOT a new top-level
 * directory, so locally-driven and remotely-ingested capture-source files
 * share one canonical location. Example:
 * "<captureSourceId>/2026/07/<captureId>.jpg".
 */
export function buildSourceCaptureStorageKey(params: {
  captureSourceId: string;
  captureId: string;
  capturedAt: Date;
  extension: string;
}): string {
  const year = String(params.capturedAt.getUTCFullYear());
  const month = String(params.capturedAt.getUTCMonth() + 1).padStart(2, "0");
  const safeCaptureId = params.captureId.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.join(params.captureSourceId, year, month, `${safeCaptureId}${params.extension}`);
}

/** Atomically renames a validated staged file into its canonical location. Only call this after every validation step has passed. */
export async function placeStagedFileAtCanonicalPath(stagingPath: string, storageKey: string): Promise<string> {
  const absolutePath = path.join(resolveCaptureSourcesDataDir(), storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await rename(stagingPath, absolutePath);
  return absolutePath;
}

/** Best-effort removal of a staged (or, on a caller's rollback path, canonical) file. Never throws. */
export async function cleanupIngestFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}
