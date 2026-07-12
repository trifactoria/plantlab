import { describe, expect, it } from "vitest";
import { buildAgentServiceUnit, validateSshHost } from "../../src/lib/operations/remoteNode";

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
});
