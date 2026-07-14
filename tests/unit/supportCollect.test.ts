import { describe, expect, it } from "vitest";
import { redact } from "../../src/lib/operations/supportCollect";

describe("support collect", () => {
  it("redacts common credential shapes", () => {
    const redacted = redact(
      [
        "PLANTLAB_NODE_CREDENTIAL=abc123",
        'Authorization: Bearer secret.token',
        '"password": "hunter2"',
        "KASA_PASSWORD=supersecret",
      ].join("\n"),
    );
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("secret.token");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("[REDACTED]");
  });
});
