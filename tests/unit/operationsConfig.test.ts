import { describe, expect, it } from "vitest";
import { isValidNodeRole, NODE_ROLES, readNodeConfig, resolveNodeConfigPath, writeNodeConfig } from "../../src/lib/operations/config";
import { resolveRootDir } from "../../src/lib/paths.server";
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
});
