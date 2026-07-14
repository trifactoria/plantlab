import { describe, expect, it } from "vitest";
import { guidanceForCode, intermittentFailureSummary } from "../../src/lib/sensorDiagnostics";

describe("guidanceForCode", () => {
  it("maps known codes to a category and likely-cause guidance", () => {
    expect(guidanceForCode("sensor-no-response").category).toBe("no-response");
    expect(guidanceForCode("dht-checksum").category).toBe("checksum");
    expect(guidanceForCode("dht-timeout").category).toBe("timeout");
    expect(guidanceForCode("temperature-hard-bound").category).toBe("hard-bound");
    expect(guidanceForCode("temperature-plausible-bound").category).toBe("plausible-bound");
    expect(guidanceForCode("gpio-unavailable").category).toBe("transport");
    expect(guidanceForCode("driver-unavailable").category).toBe("driver-unavailable");
    expect(guidanceForCode("stale").category).toBe("stale");
    expect(guidanceForCode("sensor-not-configured").category).toBe("not-configured");
  });

  it("every mapped guidance entry has at least one likely cause, and labels causes as likely not certain", () => {
    for (const code of ["sensor-no-response", "dht-checksum", "dht-timeout", "gpio-unavailable"]) {
      const guidance = guidanceForCode(code);
      expect(guidance.likelyCauses.length).toBeGreaterThan(0);
    }
  });

  it("falls back to an unknown category for an unrecognized or missing code, never throwing", () => {
    expect(guidanceForCode("totally-made-up-code").category).toBe("unknown");
    expect(guidanceForCode(null).category).toBe("unknown");
    expect(guidanceForCode(undefined).category).toBe("unknown");
  });
});

describe("intermittentFailureSummary", () => {
  it("distinguishes total failure from intermittent from healthy", () => {
    expect(intermittentFailureSummary(["failed", "failed", "failed"])).toMatchObject({ successRatePct: 0, isTotalFailure: true, isIntermittent: false });
    expect(intermittentFailureSummary(["accepted", "failed", "accepted", "failed"])).toMatchObject({ successRatePct: 50, isTotalFailure: false, isIntermittent: true });
    expect(intermittentFailureSummary(["accepted", "accepted", "accepted"])).toMatchObject({ successRatePct: 100, isTotalFailure: false, isIntermittent: false });
  });

  it("handles an empty window without throwing", () => {
    expect(intermittentFailureSummary([])).toMatchObject({ successRatePct: 0, isTotalFailure: false, isIntermittent: false });
  });
});
