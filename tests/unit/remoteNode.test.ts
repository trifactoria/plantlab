import { describe, expect, it } from "vitest";
import { buildAgentServiceUnit, buildConfigureRemoteAgentScript, validateSshHost } from "../../src/lib/operations/remoteNode";
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

  it("resolves the remote home directory before writing the credential file", () => {
    const script = buildConfigureRemoteAgentScript();

    expect(script).toContain('home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"');
    expect(script).toContain('env_dir="$home_dir/.config/plantlab"');
    expect(script).toContain('env_path="$env_dir/agent.env"');
    expect(script).not.toContain("'${HOME}/.config/plantlab/agent.env'");
    expect(script).toContain('mkdir -p "$repo" "$env_dir" "$unit_dir" "$spool"');
    expect(script).toContain('chmod 700 "$env_dir"');
    expect(script).toContain('chmod 600 "$env_tmp"');
    expect(script).toContain('mv "$env_tmp" "$env_path"');
    expect(script).toContain('if [ "$env_mode" != "600" ]');
    expect(script).toContain('if [ "$dir_mode" != "700" ]');
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
