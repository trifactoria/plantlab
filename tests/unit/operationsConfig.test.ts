import { describe, expect, it } from "vitest";
import { isValidNodeRole, NODE_ROLES, readNodeConfig, resolveNodeConfigPath, writeNodeConfig, writeNodeConfigRaw } from "../../src/lib/operations/config";
import { resolveRootDir } from "../../src/lib/paths.server";
import { readdir } from "node:fs/promises";
import path from "node:path";

describe("operations/config", () => {
  it("resolves the config path under the current PLANTLAB_ROOT_DIR", () => {
    expect(resolveNodeConfigPath()).toBe(path.join(resolveRootDir(), "plantlab.config.json"));
  });

  it("returns null when no config has been written yet", async () => {
    await expect(readNodeConfig()).resolves.toBeNull();
  });

  it("writes and reads back a role config", async () => {
    const written = await writeNodeConfig("camera-node");
    expect(written.role).toBe("camera-node");
    expect(written.formatVersion).toBe(1);
    expect(written.coordinatorUrl).toBeNull();
    expect(typeof written.hostname).toBe("string");
    expect(() => new Date(written.configuredAt).toISOString()).not.toThrow();

    const read = await readNodeConfig();
    expect(read).toEqual(written);
  });

  it("stores an optional coordinatorUrl", async () => {
    const written = await writeNodeConfig("mobile-uploader", { coordinatorUrl: "http://coordinator.local:3000" });
    expect(written.coordinatorUrl).toBe("http://coordinator.local:3000");
  });

  it("overwrites a previous config on a second install", async () => {
    await writeNodeConfig("standalone");
    const second = await writeNodeConfig("microscope-node");
    const read = await readNodeConfig();
    expect(read?.role).toBe("microscope-node");
    expect(read).toEqual(second);
  });

  it.each(NODE_ROLES)("validates %s as a real role", (role) => {
    expect(isValidNodeRole(role)).toBe(true);
  });

  it("rejects an unknown role string", () => {
    expect(isValidNodeRole("not-a-role")).toBe(false);
  });

  describe("write atomicity", () => {
    it("never leaves a temp file behind after a successful write", async () => {
      await writeNodeConfig("standalone");
      const entries = await readdir(resolveRootDir());
      const tmpFiles = entries.filter((name) => name.includes(".tmp-"));
      expect(tmpFiles).toEqual([]);
    });

    it("fully replaces the previous content rather than merging - a partial/corrupt intermediate state is never observable", async () => {
      await writeNodeConfig("coordinator", { coordinatorUrl: "http://old:3000" });
      await writeNodeConfig("camera-node", { coordinatorUrl: "http://new:3000", nodeName: "xps", spoolRoot: "/tmp/spool" });

      const read = await readNodeConfig();
      // Every field reflects the SECOND write only - nothing from the
      // first write survives partially (e.g. old coordinatorUrl kept
      // alongside a new role would indicate a non-atomic merge).
      expect(read).toEqual({
        formatVersion: 1,
        role: "camera-node",
        configuredAt: read!.configuredAt,
        hostname: read!.hostname,
        coordinatorUrl: "http://new:3000",
        nodeName: "xps",
        spoolRoot: "/tmp/spool",
      });
    });

    it("writeNodeConfigRaw writes atomically for a hand-built config object", async () => {
      const config = {
        formatVersion: 1 as const,
        role: "standalone" as const,
        configuredAt: new Date().toISOString(),
        hostname: "test-host",
        coordinatorUrl: null,
        nodeName: null,
        spoolRoot: null,
      };
      await writeNodeConfigRaw(config);
      const read = await readNodeConfig();
      expect(read).toEqual(config);

      const entries = await readdir(resolveRootDir());
      expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
    });
  });
});
