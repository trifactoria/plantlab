import { describe, expect, it } from "vitest";
import {
  buildAgentServiceUnit,
  buildCameraServiceUnit,
  buildQueryUnitStatesScript,
  buildUnitConvergenceScript,
  buildUnitContent,
  buildWebServiceUnit,
  classifyUnitState,
  isMaskedState,
  parseUnitStatesOutput,
} from "../../src/lib/operations/systemdUnits";

describe("systemdUnits", () => {
  describe("unit templates", () => {
    it("web unit runs `run start` and enables local camera hardware", () => {
      const unit = buildWebServiceUnit({ repoPath: "/repo", runBin: "/usr/bin/pnpm" });
      expect(unit).toContain("ExecStart=/usr/bin/pnpm run start");
      expect(unit).toContain("PLANTLAB_LOCAL_CAMERA_ENABLED=1");
    });

    it("camera unit runs `run camera:service`", () => {
      const unit = buildCameraServiceUnit({ repoPath: "/repo", runBin: "/usr/bin/pnpm" });
      expect(unit).toContain("ExecStart=/usr/bin/pnpm run camera:service");
    });

    it("agent unit runs `run agent:service` and never web/camera", () => {
      const unit = buildAgentServiceUnit({ repoPath: "/repo", runBin: "/usr/bin/pnpm", envPath: "/env/agent.env" });
      expect(unit).toContain("ExecStart=/usr/bin/pnpm run agent:service");
      expect(unit).toContain("EnvironmentFile=/env/agent.env");
      expect(unit).not.toContain("run start");
      expect(unit).not.toContain("run camera:service");
    });

    it("buildUnitContent dispatches to the correct template by unit name", () => {
      expect(buildUnitContent("plantlab-web.service", { repoPath: "/repo", runBin: "/bin/pnpm" })).toContain("run start");
      expect(buildUnitContent("plantlab-camera.service", { repoPath: "/repo", runBin: "/bin/pnpm" })).toContain("run camera:service");
      expect(buildUnitContent("plantlab-agent.service", { repoPath: "/repo", runBin: "/bin/pnpm" })).toContain("run agent:service");
    });
  });

  describe("classifyUnitState / isMaskedState", () => {
    it("classifies masked from either LoadState or UnitFileState", () => {
      expect(isMaskedState({ loadState: "masked", unitFileState: "" })).toBe(true);
      expect(isMaskedState({ loadState: "loaded", unitFileState: "masked" })).toBe(true);
      expect(isMaskedState({ loadState: "loaded", unitFileState: "enabled" })).toBe(false);
    });

    it("classifies active, enabled, disabled, not-found, failed correctly", () => {
      expect(classifyUnitState({ id: "x", loadState: "masked", activeState: "inactive", subState: "dead", unitFileState: "masked" })).toBe("masked");
      expect(classifyUnitState({ id: "x", loadState: "not-found", activeState: "inactive", subState: "dead", unitFileState: "" })).toBe("not-found");
      expect(classifyUnitState({ id: "x", loadState: "loaded", activeState: "failed", subState: "failed", unitFileState: "enabled" })).toBe("failed");
      expect(classifyUnitState({ id: "x", loadState: "loaded", activeState: "active", subState: "running", unitFileState: "enabled" })).toBe("active");
      expect(classifyUnitState({ id: "x", loadState: "loaded", activeState: "inactive", subState: "dead", unitFileState: "disabled" })).toBe("disabled");
    });
  });

  describe("parseUnitStatesOutput", () => {
    it("parses one or more systemctl --user show blocks separated by blank lines", () => {
      const output = [
        "Id=plantlab-web.service",
        "LoadState=loaded",
        "ActiveState=active",
        "SubState=running",
        "UnitFileState=enabled",
        "",
        "Id=plantlab-camera.service",
        "LoadState=masked",
        "ActiveState=inactive",
        "SubState=dead",
        "UnitFileState=masked",
      ].join("\n");

      const states = parseUnitStatesOutput(output);
      expect(states).toHaveLength(2);
      expect(states[0]).toEqual({ id: "plantlab-web.service", loadState: "loaded", activeState: "active", subState: "running", unitFileState: "enabled" });
      expect(states[1]).toEqual({ id: "plantlab-camera.service", loadState: "masked", activeState: "inactive", subState: "dead", unitFileState: "masked" });
    });

    it("returns an empty array for empty/whitespace-only output", () => {
      expect(parseUnitStatesOutput("")).toEqual([]);
      expect(parseUnitStatesOutput("   \n  \n")).toEqual([]);
    });
  });

  describe("buildQueryUnitStatesScript", () => {
    it("is a safe no-op for an empty unit list", () => {
      expect(buildQueryUnitStatesScript([])).toBe("true");
    });

    it("quotes unit names for the shell", () => {
      const script = buildQueryUnitStatesScript(["plantlab-web.service"]);
      expect(script).toContain("systemctl --user show 'plantlab-web.service'");
    });
  });

  describe("buildUnitConvergenceScript - the mask-recovery fix (see DEPLOYMENT.md)", () => {
    it("never writes a unit file via plain shell redirection - always mktemp + mv", () => {
      const script = buildUnitConvergenceScript(
        { install: [{ unitName: "plantlab-agent.service", content: "[Unit]\nDescription=x\n" }], stopAndDisable: [], startInstalled: true },
        "/repo",
      );
      // The historical bug: `sed ... > "$unit_path"` writes through a mask
      // symlink silently. This must never appear for a unit write again.
      expect(script).not.toMatch(/>\s*"\$unit_dir\/plantlab-agent\.service"\s*$/m);
      expect(script).toContain('mv "$unit_tmp" "$unit_dir/plantlab-agent.service"');
      expect(script).toMatch(/mktemp "\$unit_dir\/plantlab-agent\.service\.tmp\.XXXXXX"/);
    });

    it("checks is-enabled and calls unmask before ever writing/enabling a unit", () => {
      const script = buildUnitConvergenceScript(
        { install: [{ unitName: "plantlab-agent.service", content: "[Unit]\n" }], stopAndDisable: [], startInstalled: true },
        "/repo",
      );
      const unmaskCheckIndex = script.indexOf("is-enabled 'plantlab-agent.service'");
      const unmaskCallIndex = script.indexOf("systemctl --user unmask 'plantlab-agent.service'");
      const writeIndex = script.indexOf('mv "$unit_tmp"');
      const enableIndex = script.indexOf("systemctl --user enable --now 'plantlab-agent.service'");

      expect(unmaskCheckIndex).toBeGreaterThan(-1);
      expect(unmaskCallIndex).toBeGreaterThan(unmaskCheckIndex);
      expect(writeIndex).toBeGreaterThan(unmaskCallIndex);
      expect(enableIndex).toBeGreaterThan(writeIndex);
    });

    it("reports MASK-CLEARED for the caller to detect and explain", () => {
      const script = buildUnitConvergenceScript(
        { install: [{ unitName: "plantlab-agent.service", content: "[Unit]\n" }], stopAndDisable: [], startInstalled: true },
        "/repo",
      );
      expect(script).toContain('echo "MASK-CLEARED:plantlab-agent.service"');
    });

    it("stops and disables inappropriate services without deleting their unit files", () => {
      const script = buildUnitConvergenceScript(
        { install: [], stopAndDisable: ["plantlab-web.service", "plantlab-camera.service"], startInstalled: true },
        "/repo",
      );
      expect(script).toContain("systemctl --user disable --now 'plantlab-web.service' 'plantlab-camera.service'");
      expect(script).not.toContain("rm ");
    });

    it("startInstalled:false writes/unmasks units but never calls enable", () => {
      const script = buildUnitConvergenceScript(
        { install: [{ unitName: "plantlab-agent.service", content: "[Unit]\n" }], stopAndDisable: [], startInstalled: false },
        "/repo",
      );
      expect(script).not.toContain("enable --now");
      expect(script).toContain('mv "$unit_tmp" "$unit_dir/plantlab-agent.service"');
    });

    it("writes config and credential atomically via mktemp + mv, never plain redirection", () => {
      const script = buildUnitConvergenceScript(
        {
          install: [],
          stopAndDisable: [],
          startInstalled: false,
          configJson: '{"role":"camera-node"}\n',
          credentialEnv: { path: "/home/andy/.config/plantlab/agent.env", content: "PLANTLAB_NODE_CREDENTIAL=pln_test\n" },
        },
        "/repo",
      );
      expect(script).toContain('mv "$config_tmp" "$repo/plantlab.config.json"');
      expect(script).toContain("chmod 700");
      expect(script).toContain("chmod 600");
      expect(script).toMatch(/mv "\$env_tmp" .*agent\.env/);
    });
  });
});
