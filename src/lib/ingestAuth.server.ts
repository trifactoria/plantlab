import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

// See src/lib/paths.server.ts for why this is a plain runtime guard rather
// than the `server-only` package.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/ingestAuth.server.ts touches process environment secrets - it must never be imported from a Client Component or run in a browser.",
  );
}

export type IngestAuthResult =
  | { authorized: true; agentId: string }
  | { authorized: false; reason: string };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests - avoids leaking token bytes via response-time differences. */
function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Every token this coordinator will currently accept, as SHA-256 hex
 * digests only - the raw configured token value is hashed immediately and
 * never retained or logged.
 *
 * This is a temporary, single-shared-token scheme for a private home
 * network (see DEPLOYMENT.md): every agent (bokchoy, future Pi nodes, a
 * future mobile uploader) currently presents the same bearer token.
 * PLANTLAB_INGEST_TOKEN_HASH (a pre-computed SHA-256 hex digest) is
 * preferred so the raw token never needs to sit in the coordinator's own
 * environment; PLANTLAB_INGEST_TOKEN (the raw token) is also accepted for
 * simplicity while first setting this up. Replacing this with per-agent
 * credentials later only requires changing this function and the
 * agentId it returns - callers (the route) only see the IngestAuthResult
 * shape.
 */
function configuredTokenHashes(): string[] {
  const hashes: string[] = [];

  const preHashed = process.env.PLANTLAB_INGEST_TOKEN_HASH;
  if (preHashed && preHashed.trim().length > 0) {
    hashes.push(preHashed.trim().toLowerCase());
  }

  const raw = process.env.PLANTLAB_INGEST_TOKEN;
  if (raw && raw.trim().length > 0) {
    hashes.push(sha256Hex(raw.trim()));
  }

  return hashes;
}

/**
 * Authenticates one agent-ingest HTTP request against the coordinator's
 * configured ingest token(s). Isolated from the route handler so the
 * eventual move to per-agent credentials (a CaptureAgent/token table) only
 * touches this file: the route only ever consumes the IngestAuthResult
 * union.
 *
 * Never logs the Authorization header or any derived token value - only
 * a human-readable reason string safe to log/return.
 */
export function authenticateIngestRequest(request: Request): IngestAuthResult {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return { authorized: false, reason: "Missing or malformed Authorization header (expected: Bearer <token>)." };
  }

  const suppliedToken = match[1].trim();
  if (!suppliedToken) {
    return { authorized: false, reason: "Empty bearer token." };
  }

  const configured = configuredTokenHashes();
  if (configured.length === 0) {
    return { authorized: false, reason: "No ingest token is configured on this coordinator." };
  }

  const suppliedHash = sha256Hex(suppliedToken);
  const matched = configured.some((hash) => timingSafeHexEqual(hash, suppliedHash));
  if (!matched) {
    return { authorized: false, reason: "Invalid ingest token." };
  }

  // Single shared-token scheme for now - see the doc comment above.
  return { authorized: true, agentId: "shared-coordinator-token" };
}

export function unauthorizedIngestResponse(reason: string) {
  return NextResponse.json({ error: "Unauthorized", reason }, { status: 401 });
}
