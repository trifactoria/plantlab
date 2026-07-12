import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

const CLI_PATH = path.join(__dirname, "..", "..", "bin", "plantlab");

function runCli(args: string[]) {
  // Spawned as a real subprocess (bin/plantlab -> tsx -> src/cli/index.ts)
  // rather than calling buildProgram() in-process, so this actually
  // exercises the shebang launcher and process wiring end to end, not just
  // the command logic (already covered by the operations-layer unit
  // tests). Inherits process.env, so it runs against this test file's own
  // isolated PLANTLAB_ROOT_DIR/DATABASE_URL - never real PlantLab data.
  return spawnSync(CLI_PATH, args, { encoding: "utf8", env: process.env });
}

describe("plantlab CLI (subprocess smoke test)", () => {
  it("plantlab version prints the package version", () => {
    const result = runCli(["version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`plantlab ${packageJson.version}`);
  });

  it("plantlab --help lists every top-level command", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    for (const command of ["doctor", "install", "service", "node", "camera", "capture", "backup", "project"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it.each([
    [["doctor", "--help"]],
    [["backup", "--help"]],
    [["node", "inspect", "--help"]],
    [["node", "attach", "--help"]],
    [["camera", "list", "--help"]],
    [["camera", "attach", "--help"]],
    [["capture", "test", "--help"]],
    [["service", "start", "--help"]],
  ])("plantlab %s prints help", (args) => {
    const result = runCli(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("plantlab project list runs against the isolated test database (empty, not real data)", () => {
    const result = runCli(["project", "list"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("No projects found.");
  });

  it("plantlab node info reports no role configured in a fresh isolated root", () => {
    const result = runCli(["node", "info"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not configured yet");
  });

  it("an unknown command exits non-zero", () => {
    const result = runCli(["not-a-real-command"]);
    expect(result.status).not.toBe(0);
  });
});
