import { describe, expect, it } from "vitest";
import { validateSshHost } from "../../src/lib/operations/remoteNode";
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
    expect(serviceUnitsForSelection({ role: "coordinator" })).toEqual(["plantlab-web.service"]);
    expect(serviceUnitsForSelection({ role: "standalone" })).toEqual(["plantlab-web.service", "plantlab-camera.service"]);
    expect(serviceUnitsForSelection({ role: "camera-node", service: "camera" })).toEqual(["plantlab-camera.service"]);
    expect(serviceUnitsForSelection({ role: "camera-node", all: true })).toEqual([
      "plantlab-web.service",
      "plantlab-camera.service",
      "plantlab-agent.service",
    ]);
  });
});
