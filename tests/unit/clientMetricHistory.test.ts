import { describe, expect, it, vi } from "vitest";
import { defaultGapThresholdMs, fetchMetricHistory, fetchProjectMetricHistory, insertGapBreaks, rangeDefinition } from "../../src/lib/metricHistory";

describe("rangeDefinition", () => {
  it("maps every supported range to the recommended resolution", () => {
    expect(rangeDefinition("1h").resolution).toBe("raw");
    expect(rangeDefinition("6h").resolution).toBe("raw");
    expect(rangeDefinition("24h").resolution).toBe("15m");
    expect(rangeDefinition("7d").resolution).toBe("1h");
    expect(rangeDefinition("30d").resolution).toBe("1h");
  });

  it("throws for an unknown range value", () => {
    // @ts-expect-error deliberately invalid range for the error-path test
    expect(() => rangeDefinition("3h")).toThrow();
  });
});

describe("defaultGapThresholdMs", () => {
  it("uses a small multiple of the bucket size for bucketed resolutions", () => {
    expect(defaultGapThresholdMs("15m", [])).toBe(15 * 60_000 * 2.5);
    expect(defaultGapThresholdMs("1h", [])).toBe(60 * 60_000 * 2.5);
  });

  it("derives a threshold from the median spacing of raw points", () => {
    const points = [{ at: 0 }, { at: 60_000 }, { at: 120_000 }, { at: 180_000 }];
    // median delta is 60s; 6x that (360s) is below the 30-minute floor.
    expect(defaultGapThresholdMs("raw", points)).toBe(30 * 60_000);
  });

  it("falls back to a 30-minute floor when there are fewer than two raw points", () => {
    expect(defaultGapThresholdMs("raw", [])).toBe(30 * 60_000);
    expect(defaultGapThresholdMs("raw", [{ at: 0 }])).toBe(30 * 60_000);
  });
});

describe("insertGapBreaks", () => {
  it("leaves closely-spaced points untouched", () => {
    const points = [
      { at: 0, value: 1 },
      { at: 1000, value: 2 },
      { at: 2000, value: 3 },
    ];
    expect(insertGapBreaks(points, 5000)).toEqual(points);
  });

  it("inserts a null-valued break point between a gap larger than the threshold", () => {
    const points = [
      { at: 0, value: 1 },
      { at: 100_000, value: 2 },
    ];
    const result = insertGapBreaks(points, 5000);
    expect(result).toHaveLength(3);
    expect(result[1].value).toBeNull();
    expect(result[1].at).toBeGreaterThan(0);
    expect(result[1].at).toBeLessThan(100_000);
  });

  it("handles multiple gaps across a longer series", () => {
    const points = [
      { at: 0, value: 1 },
      { at: 100_000, value: 2 }, // gap after this
      { at: 200_000, value: 3 },
      { at: 500_000, value: 4 }, // gap after this
    ];
    const result = insertGapBreaks(points, 150_000);
    const nullCount = result.filter((point) => point.value === null).length;
    expect(nullCount).toBe(1);
  });
});

describe("fetchMetricHistory", () => {
  function mockFetch(body: unknown, ok = true) {
    return vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    }) as unknown as typeof fetch;
  }

  it("returns empty series per metric without making a request when sensorKeys or metrics are empty", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchMetricHistory({ nodeName: "n", sensorKeys: [], metrics: ["temperatureC"], range: "24h", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.seriesByMetric.temperatureC).toEqual([]);
  });

  it("normalizes a successful response, grouping series by metric and converting timestamps to epoch ms", async () => {
    const fetchImpl = mockFetch({
      range: { from: "2026-07-13T12:00:00.000Z", to: "2026-07-14T12:00:00.000Z", resolution: "15m" },
      series: [
        {
          key: "greenhouse-outside:temperatureC",
          subjectKey: "greenhouse-outside",
          metric: "temperatureC",
          label: "Outside temperature",
          unit: "celsius",
          points: [
            { at: "2026-07-14T10:00:00.000Z", value: 20 },
            { at: "2026-07-14T10:15:00.000Z", value: 21 },
          ],
        },
        {
          key: "greenhouse-outside:humidityPct",
          subjectKey: "greenhouse-outside",
          metric: "humidityPct",
          label: "Outside humidity",
          unit: "percent",
          points: [{ at: "2026-07-14T10:00:00.000Z", value: 55 }],
        },
      ],
    });

    const result = await fetchMetricHistory({
      nodeName: "greenhouse-zero",
      sensorKeys: ["greenhouse-outside"],
      metrics: ["temperatureC", "humidityPct"],
      range: "24h",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution).toBe("15m");
    expect(result.seriesByMetric.temperatureC).toHaveLength(1);
    expect(result.seriesByMetric.temperatureC[0].points[0].at).toBe(new Date("2026-07-14T10:00:00.000Z").getTime());
    expect(result.seriesByMetric.humidityPct).toHaveLength(1);

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/nodes/greenhouse-zero/metrics/history?");
    expect(url).toContain("sensorKeys=greenhouse-outside");
    expect(url).toContain("metrics=temperatureC%2ChumidityPct");
    expect(url).toContain("resolution=15m");
  });

  it("returns a structured error when the response is not ok", async () => {
    const fetchImpl = mockFetch({ error: "Unknown sensor key(s): bogus." }, false);
    const result = await fetchMetricHistory({ nodeName: "n", sensorKeys: ["bogus"], metrics: ["temperatureC"], range: "1h", fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Unknown sensor key(s): bogus.");
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const result = await fetchMetricHistory({ nodeName: "n", sensorKeys: ["s"], metrics: ["temperatureC"], range: "1h", fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Could not reach the coordinator.");
  });
});

describe("fetchProjectMetricHistory", () => {
  function mockFetch(body: unknown, ok = true) {
    return vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    }) as unknown as typeof fetch;
  }

  it("returns empty series per metric without making a request when bindingIds is an empty array", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchProjectMetricHistory({
      projectId: "p1",
      bindingIds: [],
      metrics: ["temperatureC"],
      range: "24h",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.seriesByMetric.temperatureC).toEqual([]);
  });

  it("hits the project-scoped endpoint with bindingIds instead of sensorKeys", async () => {
    const fetchImpl = mockFetch({
      range: { from: "2026-07-13T12:00:00.000Z", to: "2026-07-14T12:00:00.000Z", resolution: "raw" },
      series: [
        {
          key: "binding-1:temperatureC",
          subjectKey: "greenhouse-outside",
          metric: "temperatureC",
          label: "Outside temperature",
          unit: "celsius",
          points: [{ at: "2026-07-14T10:00:00.000Z", value: 20 }],
        },
      ],
    });

    const result = await fetchProjectMetricHistory({
      projectId: "proj-123",
      bindingIds: ["binding-1"],
      metrics: ["temperatureC"],
      range: "1h",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seriesByMetric.temperatureC).toHaveLength(1);
    expect(result.seriesByMetric.temperatureC[0].key).toBe("binding-1:temperatureC");

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/projects/proj-123/metrics/history?");
    expect(url).toContain("bindingIds=binding-1");
    expect(url).not.toContain("sensorKeys");
  });

  it("omits bindingIds from the query when none are given, requesting every enabled binding", async () => {
    const fetchImpl = mockFetch({ range: { from: "a", to: "b", resolution: "raw" }, series: [] });
    await fetchProjectMetricHistory({ projectId: "proj-all", metrics: ["temperatureC"], range: "1h", fetchImpl });
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).not.toContain("bindingIds");
  });

  it("returns a structured error when the response is not ok", async () => {
    const fetchImpl = mockFetch({ error: "Unknown sensor binding id(s): bogus." }, false);
    const result = await fetchProjectMetricHistory({ projectId: "p", bindingIds: ["bogus"], metrics: ["temperatureC"], range: "1h", fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Unknown sensor binding id(s): bogus.");
  });
});
