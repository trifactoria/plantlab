import { describe, expect, it } from "vitest";
import {
  deriveCapabilitiesFromEdgeConfig,
  mergeEdgeAgentConfig,
  parseGreenhousePower,
  parseGreenhouseSensors,
  pythonKasaReadiness,
  redactedGreenhouseSummary,
  validateGreenhouseConfig,
  type GreenhouseSensorConfig,
} from "../../src/lib/operations/greenhouseConfig";

const sensor: GreenhouseSensorConfig = {
  key: "greenhouse-ambient",
  name: "Greenhouse ambient",
  type: "dht22",
  gpio: 4,
  placement: "Top shelf",
  enabled: true,
};

describe("greenhouse edge-agent configuration", () => {
  it("loads missing optional sections as empty/absent", () => {
    expect(parseGreenhouseSensors(undefined)).toEqual([]);
    expect(parseGreenhousePower(undefined)).toBeNull();
    expect(validateGreenhouseConfig({ role: "greenhouse-node" })).toEqual({ ok: true, errors: [] });
  });

  it("validates DHT22 sensor definitions", () => {
    expect(parseGreenhouseSensors([sensor])).toEqual([sensor]);
    expect(() => parseGreenhouseSensors([{ ...sensor, type: "ds18b20" }])).toThrow(/Unsupported sensor type/);
    expect(() => parseGreenhouseSensors([{ ...sensor, gpio: "4" }])).toThrow(/BCM GPIO/);
    expect(validateGreenhouseConfig({ sensors: [sensor, { ...sensor, name: "Duplicate" }] }).errors).toContain('Duplicate sensor key "greenhouse-ambient".');
    expect(validateGreenhouseConfig({ sensors: [sensor, { ...sensor, key: "other" }] }).errors).toContain("Duplicate BCM GPIO assignment 4.");
  });

  it("validates power provider and logical outlet mapping", () => {
    expect(parseGreenhousePower({ provider: "kasa", host: "192.168.1.72", outlets: { fans: "greenhouse-fans" } })).toEqual({
      provider: "kasa",
      host: "192.168.1.72",
      outlets: { fans: "greenhouse-fans" },
      outletBehaviors: { fans: "normal" },
    });
    expect(parseGreenhousePower({ provider: "kasa", host: "192.168.1.72", outlets: { water: "greenhouse-water" }, outletBehaviors: { water: "pulse-only" } })).toEqual({
      provider: "kasa",
      host: "192.168.1.72",
      outlets: { water: "greenhouse-water" },
      outletBehaviors: { water: "pulse-only" },
    });
    expect(() => parseGreenhousePower({ provider: "other", host: "x" })).toThrow(/Unsupported power provider/);
    expect(() => parseGreenhousePower({ provider: "kasa", host: "x", outlets: { heater: "x" } })).toThrow(/Unsupported power outlet key/);
    expect(() => parseGreenhousePower({ provider: "kasa", host: "x", outlets: { fans: "" } })).toThrow(/non-empty string/);
    expect(() => parseGreenhousePower({ provider: "kasa", host: "x", outlets: { fans: "x" }, outletBehaviors: { fans: "always-on" } })).toThrow(/outletBehaviors/);
  });

  it("derives capabilities only from valid configured greenhouse functionality", () => {
    expect(deriveCapabilitiesFromEdgeConfig({ role: "greenhouse-node", capabilities: ["camera"] })).toEqual(["camera"]);
    expect(deriveCapabilitiesFromEdgeConfig({ role: "greenhouse-node", capabilities: [], sensors: [sensor] })).toEqual(["temperature", "humidity"]);
    expect(deriveCapabilitiesFromEdgeConfig({ role: "greenhouse-node", capabilities: ["camera"], sensors: [sensor] })).toEqual(["camera", "temperature", "humidity"]);
    expect(
      deriveCapabilitiesFromEdgeConfig({
        role: "greenhouse-node",
        capabilities: [],
        power: { provider: "kasa", host: "192.168.1.72", outlets: { fans: "greenhouse-fans" } },
      }),
    ).toEqual(["relay", "fan"]);
    expect(
      deriveCapabilitiesFromEdgeConfig({
        role: "greenhouse-node",
        capabilities: [],
        power: { provider: "kasa", host: "192.168.1.72", outlets: { fans: "greenhouse-fans", water: "greenhouse-water", lights: "greenhouse-lights" } },
      }),
    ).toEqual(["relay", "fan", "light", "pump"]);
    expect(deriveCapabilitiesFromEdgeConfig({ role: "greenhouse-node", capabilities: [], sensors: [{ ...sensor, enabled: false }] })).toEqual([]);
    expect(deriveCapabilitiesFromEdgeConfig({ role: "camera-node", capabilities: ["camera"], sensors: [sensor] })).toEqual(["camera"]);
  });

  it("merges attach updates without dropping unknown fields or unrelated greenhouse sections", () => {
    const merged = mergeEdgeAgentConfig(
      {
        role: "greenhouse-node",
        nodeName: "old",
        coordinatorUrl: "http://old",
        spoolRoot: "/old",
        capabilities: ["camera"],
        sensors: [sensor],
        power: { provider: "kasa", host: "192.168.1.72", outlets: { fans: "greenhouse-fans" }, futurePowerField: "keep" },
        unknownTopLevel: { nested: true },
        heartbeatIntervalSeconds: 17,
      },
      {
        role: "greenhouse-node",
        nodeName: "greenhouse-zero",
        coordinatorUrl: "http://coordinator:3000",
        spoolRoot: "/spool",
        cameraEnabled: true,
      },
    );
    expect(merged.nodeName).toBe("greenhouse-zero");
    expect(merged.coordinatorUrl).toBe("http://coordinator:3000");
    expect(merged.sensors).toEqual([sensor]);
    expect(merged.power).toMatchObject({ provider: "kasa", host: "192.168.1.72", outlets: { fans: "greenhouse-fans" }, futurePowerField: "keep" });
    expect(merged.power).toMatchObject({ outletBehaviors: { fans: "normal" } });
    expect(merged.unknownTopLevel).toEqual({ nested: true });
    expect(merged.heartbeatIntervalSeconds).toBe(17);
    expect(merged.capabilities).toEqual(["camera", "temperature", "humidity", "relay", "fan"]);
  });

  it("explicitly disables sensors and power", () => {
    const merged = mergeEdgeAgentConfig(
      {
        role: "greenhouse-node",
        nodeName: "greenhouse-zero",
        coordinatorUrl: "http://old",
        spoolRoot: "/spool",
        capabilities: ["camera"],
        sensors: [sensor],
        power: { provider: "kasa", host: "192.168.1.72", outlets: { water: "greenhouse-water" } },
      },
      {
        role: "greenhouse-node",
        nodeName: "greenhouse-zero",
        coordinatorUrl: "http://coordinator:3000",
        spoolRoot: "/spool",
        cameraEnabled: true,
        disableSensors: true,
        disablePower: true,
      },
    );
    expect(merged.sensors).toBeUndefined();
    expect(merged.power).toBeUndefined();
    expect(merged.capabilities).toEqual(["camera"]);
  });

  it("redacts summaries and reports Python Kasa readiness", () => {
    const summary = redactedGreenhouseSummary(
      {
        role: "greenhouse-node",
        nodeName: "greenhouse-zero",
        capabilities: ["camera"],
        power: { provider: "kasa", host: "192.168.1.72", outlets: { fans: "greenhouse-fans" } },
      },
      { secretFileExists: true, pythonVersion: "3.9.2" },
    );
    expect(JSON.stringify(summary)).not.toContain("KASA_PASSWORD");
    expect(summary.greenhouseSecretFileExists).toBe(true);
    expect(summary.pythonKasaReadiness?.status).toBe("not-ready");
    expect(pythonKasaReadiness("3.11.0").status).toBe("ready");
    expect(pythonKasaReadiness(null).status).toBe("unknown");
  });
});
