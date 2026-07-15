import { describe, expect, it } from "vitest";
import { calculateMetricDomain, HUMIDITY_DOMAIN, TEMPERATURE_F_DOMAIN } from "../../src/lib/chartDomain";

describe("calculateMetricDomain", () => {
  it("scales temperature around visible data", () => {
    const result = calculateMetricDomain([68.2, 69.1, null, 70.4], TEMPERATURE_F_DOMAIN);
    expect(result.empty).toBe(false);
    expect(result.domain[0]).toBeLessThanOrEqual(68);
    expect(result.domain[1]).toBeGreaterThanOrEqual(72);
    expect(result.domain[0]).toBeGreaterThan(50);
  });

  it("does not default humidity to 0-100 when data is narrow", () => {
    const result = calculateMetricDomain([47, 48, 49, null], HUMIDITY_DOMAIN);
    expect(result.domain[0]).toBeGreaterThanOrEqual(35);
    expect(result.domain[1]).toBeLessThanOrEqual(60);
  });

  it("expands a flat series", () => {
    const result = calculateMetricDomain([72, 72, 72], TEMPERATURE_F_DOMAIN);
    expect(result.domain[1] - result.domain[0]).toBeGreaterThanOrEqual(6);
    expect(result.domain[0]).toBeLessThan(72);
    expect(result.domain[1]).toBeGreaterThan(72);
  });

  it("ignores hidden series when caller passes only visible values", () => {
    const result = calculateMetricDomain([70, 71], TEMPERATURE_F_DOMAIN);
    expect(result.domain[1]).toBeLessThan(80);
  });

  it("respects physical humidity bounds", () => {
    const result = calculateMetricDomain([-5, 2, 98, 110], HUMIDITY_DOMAIN);
    expect(result.domain[0]).toBe(0);
    expect(result.domain[1]).toBe(100);
  });

  it("returns a stable empty domain", () => {
    const result = calculateMetricDomain([null, undefined], HUMIDITY_DOMAIN);
    expect(result).toMatchObject({ domain: [0, 10], empty: true });
    expect(result.ticks.length).toBeGreaterThan(0);
  });
});
