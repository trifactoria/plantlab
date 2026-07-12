import { NextResponse } from "next/server";
import type { SourceCapture } from "@prisma/client";
import {
  buildSourceCaptureStorageKey,
  cleanupIngestFile,
  IngestRequestError,
  parseIngestMetadata,
  placeStagedFileAtCanonicalPath,
  receiveIngestMultipart,
  resolveIngestCaptureSource,
  SUPPORTED_INGEST_MIME_TYPES,
  validateStagedImage,
  verifyStagedUploadMatchesExpectations,
  type ParsedIngestMetadata,
} from "@/lib/ingest.server";
import { authenticateIngestRequest, unauthorizedIngestResponse } from "@/lib/ingestAuth.server";
import { prisma } from "@/lib/prisma";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { runViewportFanOut } from "@/lib/viewportFanOut";

function ingestErrorResponse(error: unknown) {
  if (error instanceof IngestRequestError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("agent-ingest: unexpected failure", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/**
 * A retried captureId that already has a durable SourceCapture row.
 * Identical content (checksum + size match) is a successful idempotent
 * retry (200) - a different checksum/size for the same captureId is a
 * conflict (409), and the original accepted upload is left untouched
 * either way.
 */
function respondToExistingCapture(existing: SourceCapture, metadata: ParsedIngestMetadata) {
  const matches = existing.sha256 === metadata.expectedSha256 && existing.byteSize === metadata.expectedByteSize;

  if (matches) {
    return NextResponse.json(
      { status: "already-exists", sourceCaptureId: existing.id, captureId: existing.captureId },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      error: `captureId "${metadata.captureId}" was already ingested with different content (checksum/size mismatch). The original upload was preserved.`,
    },
    { status: 409 },
  );
}

/**
 * Durable HTTP ingest endpoint for capture agents (bokchoy today, future
 * Raspberry Pi nodes, a future mobile uploader, and manual curl testing) -
 * see DEPLOYMENT.md for the full request format, auth setup, and curl
 * examples. Ordinary HTTP over LAN or a Tailscale network route; no
 * Taildrop, file-transfer APIs, SMB, NFS, or Git involved.
 *
 * `?mode=store-only` stores the SourceCapture without immediately running
 * viewport fan-out (the default runs fan-out right away, matching the
 * intended coordinator workflow of "ingest and publish in one step").
 */
export async function POST(request: Request) {
  const auth = authenticateIngestRequest(request);
  if (!auth.authorized) {
    return unauthorizedIngestResponse(auth.reason);
  }

  const url = new URL(request.url);
  const runFanOut = url.searchParams.get("mode") !== "store-only";

  let stagingPathToClean: string | null = null;

  try {
    const staged = await receiveIngestMultipart(request);
    stagingPathToClean = staged.stagingPath;

    const metadata = parseIngestMetadata(staged.metadataRaw);
    const resolvedSource = await resolveIngestCaptureSource(prisma, metadata);
    const captureSource = await prisma.captureSource.findUniqueOrThrow({ where: { id: resolvedSource.id } });

    // Idempotency pre-check, before spending effort re-verifying a staged
    // upload we already trust from the first accepted attempt.
    const existing = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId } });
    if (existing) {
      await cleanupIngestFile(staged.stagingPath);
      stagingPathToClean = null;
      return respondToExistingCapture(existing, metadata);
    }

    verifyStagedUploadMatchesExpectations(staged, metadata);
    const image = await validateStagedImage(staged.stagingPath, metadata);

    const extension = SUPPORTED_INGEST_MIME_TYPES.get(metadata.mimeType) ?? ".jpg";
    const storageKey = buildSourceCaptureStorageKey({
      captureSourceId: captureSource.id,
      captureId: metadata.captureId,
      capturedAt: metadata.capturedAt,
      extension,
    });

    const absolutePath = await placeStagedFileAtCanonicalPath(staged.stagingPath, storageKey);
    stagingPathToClean = null; // No longer at stagingPath - failures from here must clean up absolutePath instead.

    let sourceCapture: SourceCapture;
    try {
      sourceCapture = await prisma.sourceCapture.create({
        data: {
          captureSourceId: captureSource.id,
          timestamp: metadata.capturedAt,
          originalPath: absolutePath,
          originalWidth: image.width,
          originalHeight: image.height,
          // Mirrors captureSourcePhoto()'s convention: workingWidth/Height
          // are the CaptureSource's own declared canonical working
          // dimensions (what viewport crop fractions are normalized
          // against), not necessarily the uploaded image's raw dimensions.
          workingWidth: captureSource.width,
          workingHeight: captureSource.height,
          pixelFormat: image.format,
          captureId: metadata.captureId,
          sha256: metadata.expectedSha256,
          byteSize: staged.byteSize,
          mimeType: metadata.mimeType,
          originalFilename: metadata.originalFilename,
          storageKey,
          ingestSource: "http-agent-ingest",
        },
      });
    } catch (error) {
      // The file is already durably placed - a DB failure here must not
      // leave it as an untracked canonical file.
      if (isUniqueConstraintError(error)) {
        await cleanupIngestFile(absolutePath);
        const raceWinner = await prisma.sourceCapture.findUnique({ where: { captureId: metadata.captureId } });
        if (raceWinner) {
          return respondToExistingCapture(raceWinner, metadata);
        }
        return NextResponse.json({ error: "Concurrent ingest conflict for this captureId. Retry the upload." }, { status: 503 });
      }

      await cleanupIngestFile(absolutePath);
      throw error;
    }

    if (runFanOut) {
      try {
        await runViewportFanOut(sourceCapture.id);
      } catch (error) {
        // The SourceCapture is already durably stored - a fan-out problem
        // must never turn a successfully accepted upload into a failure
        // response the agent would feel compelled to retry. Per-project
        // fan-out failures are already isolated/reported inside
        // runViewportFanOut itself; this only catches something going
        // wrong with the fan-out call as a whole.
        console.error("agent-ingest: viewport fan-out failed after a successful ingest", error);
      }
    }

    return NextResponse.json(
      {
        status: "created",
        sourceCaptureId: sourceCapture.id,
        captureId: sourceCapture.captureId,
        storageKey,
        fanOutTriggered: runFanOut,
      },
      { status: 201 },
    );
  } catch (error) {
    if (stagingPathToClean) {
      await cleanupIngestFile(stagingPathToClean);
    }
    return ingestErrorResponse(error);
  }
}
