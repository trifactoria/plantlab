import { describe, expect, it } from "vitest";
import { computeFullAgentSupport, validateSshHost } from "../../src/lib/operations/remoteNode";
import { buildAgentServiceUnit } from "../../src/lib/operations/systemdUnits";
import { serviceUnitsForSelection } from "../../src/lib/operations/serviceRoles";

describe("remote node helpers", () => {
  it("rejects unsafe SSH host strings before spawning ssh", () => {
    expect(() => validateSshHost("xps")).not.toThrow();
    expect(() => validateSshHost("andy@xps")).not.toThrow();
    expect(() => validateSshHost("xps;rm -rf /")).toThrow(/Unsafe SSH host/);
    expect(() => validateSshHost("-oProxyCommand=bad")).toThrow(/Unsafe SSH host/);
  });

  it("generates an agent service that runs only the agent runtime", () => {
    const unit = buildAgentServiceUnit({
      repoPath: "/home/andy/projects/plantlab",
      runBin: "/usr/bin/pnpm",
      envPath: "/home/andy/.config/plantlab/agent.env",
    });

    expect(unit).toContain("plantlab-agent");
    expect(unit).toContain("EnvironmentFile=/home/andy/.config/plantlab/agent.env");
    expect(unit).toContain("ExecStart=/usr/bin/pnpm run agent:service");
    expect(unit).not.toContain("run start");
  });

  it("selects services by role instead of defaulting to every service", () => {
    expect(serviceUnitsForSelection({ role: "camera-node" })).toEqual(["plantlab-agent.service"]);
    expect(serviceUnitsForSelection({ role: "coordinator" })).toEqual(["plantlab-web.service", "plantlab-camera.service"]);
    expect(serviceUnitsForSelection({ role: "standalone" })).toEqual(["plantlab-web.service", "plantlab-camera.service"]);
    expect(serviceUnitsForSelection({ role: "camera-node", service: "camera" })).toEqual(["plantlab-camera.service"]);
    expect(serviceUnitsForSelection({ role: "camera-node", all: true })).toEqual([
      "plantlab-web.service",
      "plantlab-camera.service",
      "plantlab-agent.service",
    ]);
  });

  describe("computeFullAgentSupport (Part 5 - Pi Zero feasibility)", () => {
    it("recommends the edge agent for a real Pi Zero v1.2 (armv6l, 512MB)", () => {
      const result = computeFullAgentSupport({ armVersion: "v6", memoryTotalMb: 512 });
      expect(result.fullAgentSupported).toBe(false);
      expect(result.recommendedRuntime).toBe("python-edge");
    });

    it("recommends the full agent for a capable ARM64 machine with plenty of memory", () => {
      const result = computeFullAgentSupport({ armVersion: "v8", memoryTotalMb: 4096 });
      expect(result.fullAgentSupported).toBe(true);
      expect(result.recommendedRuntime).toBe("node");
    });

    it("recommends the full agent for a capable x86_64 machine (armVersion null)", () => {
      const result = computeFullAgentSupport({ armVersion: null, memoryTotalMb: 8192 });
      expect(result.fullAgentSupported).toBe(true);
      expect(result.recommendedRuntime).toBe("node");
    });

    it("recommends the edge agent purely on low memory, even on a newer ARM ISA", () => {
      const result = computeFullAgentSupport({ armVersion: "v7", memoryTotalMb: 256 });
      expect(result.fullAgentSupported).toBe(false);
      expect(result.recommendedRuntime).toBe("python-edge");
    });

    it("does not penalize an unknown memory reading (null) on capable-ISA hardware", () => {
      const result = computeFullAgentSupport({ armVersion: "v8", memoryTotalMb: null });
      expect(result.fullAgentSupported).toBe(true);
    });
  });
});
