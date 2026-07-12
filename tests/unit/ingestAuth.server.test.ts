import { afterEach, describe, expect, it } from "vitest";
import { authenticateIngestRequest } from "../../src/lib/ingestAuth.server";

const ORIGINAL_TOKEN = process.env.PLANTLAB_INGEST_TOKEN;
const ORIGINAL_TOKEN_HASH = process.env.PLANTLAB_INGEST_TOKEN_HASH;

// Known SHA-256 hex digest of "test-token-abc", precomputed independently
// of the module under test so this doesn't just re-derive its own oracle.
const KNOWN_TOKEN = "test-token-abc";
const KNOWN_TOKEN_HASH = "fa3833407e6d199edfa14732e513e645794e5c9f156d588a3cc718d2c42e62a5";

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.PLANTLAB_INGEST_TOKEN;
  } else {
    process.env.PLANTLAB_INGEST_TOKEN = ORIGINAL_TOKEN;
  }
  if (ORIGINAL_TOKEN_HASH === undefined) {
    delete process.env.PLANTLAB_INGEST_TOKEN_HASH;
  } else {
    process.env.PLANTLAB_INGEST_TOKEN_HASH = ORIGINAL_TOKEN_HASH;
  }
});

function requestWithAuthHeader(headerValue: string | null) {
  const headers = new Headers();
  if (headerValue !== null) {
    headers.set("authorization", headerValue);
  }
  return new Request("http://localhost/api/agent-ingest", { method: "POST", headers });
}

describe("authenticateIngestRequest", () => {
  it("rejects when no token is configured on the coordinator at all", () => {
    delete process.env.PLANTLAB_INGEST_TOKEN;
    delete process.env.PLANTLAB_INGEST_TOKEN_HASH;

    const result = authenticateIngestRequest(requestWithAuthHeader(`Bearer ${KNOWN_TOKEN}`));
    expect(result.authorized).toBe(false);
  });

  it("rejects a request with no Authorization header", () => {
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader(null));
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.reason).toMatch(/Authorization header/);
    }
  });

  it("rejects malformed credentials (not a Bearer token)", () => {
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader(`Basic ${KNOWN_TOKEN}`));
    expect(result.authorized).toBe(false);
  });

  it("rejects an empty bearer token", () => {
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader("Bearer "));
    expect(result.authorized).toBe(false);
  });

  it("rejects an incorrect token", () => {
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader("Bearer wrong-token"));
    expect(result.authorized).toBe(false);
  });

  it("accepts the correct token configured via the raw PLANTLAB_INGEST_TOKEN env var", () => {
    delete process.env.PLANTLAB_INGEST_TOKEN_HASH;
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader(`Bearer ${KNOWN_TOKEN}`));
    expect(result.authorized).toBe(true);
  });

  it("accepts the correct token configured via a pre-computed PLANTLAB_INGEST_TOKEN_HASH", () => {
    delete process.env.PLANTLAB_INGEST_TOKEN;
    process.env.PLANTLAB_INGEST_TOKEN_HASH = KNOWN_TOKEN_HASH;
    const result = authenticateIngestRequest(requestWithAuthHeader(`Bearer ${KNOWN_TOKEN}`));
    expect(result.authorized).toBe(true);
  });

  it("rejects a token that only matches the wrong-length hash comparison boundary", () => {
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader(`Bearer ${KNOWN_TOKEN}extra`));
    expect(result.authorized).toBe(false);
  });

  it("is case-insensitive on the Bearer scheme keyword", () => {
    process.env.PLANTLAB_INGEST_TOKEN = KNOWN_TOKEN;
    const result = authenticateIngestRequest(requestWithAuthHeader(`bearer ${KNOWN_TOKEN}`));
    expect(result.authorized).toBe(true);
  });
});
