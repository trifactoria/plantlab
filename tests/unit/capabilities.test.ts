import { describe, expect, it } from "vitest";
import {
  defaultCapabilitiesForRole,
  isValidCapability,
  NODE_CAPABILITIES,
  parseCapabilities,
  serializeCapabilities,
} from "../../src/lib/operations/capabilities";

describe("capabilities (Part 6)", () => {
  it("recognizes every declared capability as valid and rejects unknown strings", () => {
    for (const cap of NODE_CAPABILITIES) {
      expect(isValidCapability(cap)).toBe(true);
    }
    expect(isValidCapability("laser")).toBe(false);
    expect(isValidCapability(42)).toBe(false);
  });

  it("parseCapabilities never throws on missing/malformed input", () => {
    expect(parseCapabilities(null)).toEqual([]);
    expect(parseCapabilities(undefined)).toEqual([]);
    expect(parseCapabilities("not json")).toEqual([]);
    expect(parseCapabilities("42")).toEqual([]);
    expect(parseCapabilities('["camera","bogus","relay"]')).toEqual(["camera", "relay"]);
  });

  it("serializeCapabilities dedupes and drops invalid entries", () => {
    const json = serializeCapabilities(["camera", "camera", "bogus", "relay"]);
    expect(JSON.parse(json)).toEqual(["camera", "relay"]);
  });

  it("defaultCapabilitiesForRole gives camera-node and greenhouse-node just [camera] - never sensor/relay capabilities by default", () => {
    expect(defaultCapabilitiesForRole("camera-node")).toEqual(["camera"]);
    expect(defaultCapabilitiesForRole("greenhouse-node")).toEqual(["camera"]);
    expect(defaultCapabilitiesForRole("microscope-node")).toEqual(["microscope"]);
    expect(defaultCapabilitiesForRole("coordinator")).toEqual([]);
    expect(defaultCapabilitiesForRole("standalone")).toEqual([]);
    expect(defaultCapabilitiesForRole(null)).toEqual([]);
  });
});
