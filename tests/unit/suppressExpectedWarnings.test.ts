import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { suppressExpectedNodeWarnings } from "../../src/lib/suppressExpectedWarnings";

/**
 * A plain process.on("warning", ...) listener does NOT stop Node's own
 * default stderr print (verified empirically against this Node version) -
 * the module instead intercepts process.emitWarning itself. Because Node's
 * default printer doesn't reliably go through a mockable in-process hook
 * either, the real behavior is verified end to end via real child
 * processes (spawned through tsx, the same way the CLI/agent entrypoints
 * run) rather than by mocking internals and hoping they match reality.
 */
function runScript(body: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), "-e", body],
    { cwd: __dirname, encoding: "utf8" },
  );
}

describe("suppressExpectedNodeWarnings", () => {
  it("is idempotent - installing more than once does not wrap emitWarning multiple times", () => {
    suppressExpectedNodeWarnings();
    const wrappedOnce = process.emitWarning;
    suppressExpectedNodeWarnings();
    suppressExpectedNodeWarnings();
    expect(process.emitWarning).toBe(wrappedOnce);
  });

  it("produces no ExperimentalWarning output for the known SQLite warning once installed", () => {
    const result = runScript(
      [
        'const { suppressExpectedNodeWarnings } = require("../../src/lib/suppressExpectedWarnings");',
        "suppressExpectedNodeWarnings();",
        'process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");',
        'console.log("ok");',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/ExperimentalWarning/);
    expect(result.stdout).toContain("ok");
  });

  it("still prints other ExperimentalWarnings unrelated to SQLite", () => {
    const result = runScript(
      [
        'const { suppressExpectedNodeWarnings } = require("../../src/lib/suppressExpectedWarnings");',
        "suppressExpectedNodeWarnings();",
        'process.emitWarning("Something else entirely is experimental", "ExperimentalWarning");',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/ExperimentalWarning: Something else entirely is experimental/);
  });

  it("still prints a warning whose message happens to mention SQLite but has a different, explicit type", () => {
    const result = runScript(
      [
        'const { suppressExpectedNodeWarnings } = require("../../src/lib/suppressExpectedWarnings");',
        "suppressExpectedNodeWarnings();",
        'process.emitWarning("SQLite is an experimental feature and might change at any time", "DeprecationWarning");',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/DeprecationWarning: SQLite is an experimental feature/);
  });

  it("produces no ExperimentalWarning output when the real node:sqlite module is imported after installing", () => {
    const result = runScript(
      [
        'const { suppressExpectedNodeWarnings } = require("../../src/lib/suppressExpectedWarnings");',
        "suppressExpectedNodeWarnings();",
        'require("node:sqlite");',
        'console.log("ok");',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/ExperimentalWarning/);
    expect(result.stdout).toContain("ok");
  });

  it("without the fix, importing node:sqlite does print the warning (sanity check for the tests above)", () => {
    const result = runScript(['require("node:sqlite");', 'console.log("ok");'].join("\n"));
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/ExperimentalWarning: SQLite is an experimental feature/);
  });
});
