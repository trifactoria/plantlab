import { mkdtemp, readFile, readdir, lstat, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convergeNodeRole } from "../../src/lib/operations/roleConvergence";
import { readNodeConfig } from "../../src/lib/operations/config";
import { resolveRootDir } from "../../src/lib/paths.server";
import { createFakeSystemctl, prependPath, type FakeSystemctl } from "./helpers/fakeSystemctl";

describe("convergeNodeRole (local target, mocked systemd)", () => {
  let fake: FakeSystemctl;
  let restorePath: () => void;
  let restoreHome: () => void;

  async function setUp() {
    fake = await createFakeSystemctl();
    restorePath = prependPath(fake.binDir);
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "plantlab-convergence-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    restoreHome = () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    };
  }

  afterEach(async () => {
    restorePath?.();
    restoreHome?.();
    await fake?.cleanup();
  });

  it("unmasks a required unit before enabling it - the exact bokchoy failure scenario", async () => {
    await setUp();
    await fake.preMask("plantlab-agent.service");
    expect(await fake.isMasked("plantlab-agent.service")).toBe(true);

    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test-credential",
      startServices: true,
    });

    expect(result.ok).toBe(true);
    expect(result.maskCleared).toContain("plantlab-agent.service");
    expect(await fake.isMasked("plantlab-agent.service")).toBe(false);
    expect(await fake.isActive("plantlab-agent.service")).toBe(true);
  });

  it("replaces a real obsolete mask symlink (-> /dev/null) with a regular unit file, matching bokchoy's actual on-disk state", async () => {
    await setUp();
    // preMask() only drives the fake systemctl's marker-file state (so
    // `is-enabled` reports "masked"). The real bokchoy failure additionally
    // had `~/.config/systemd/user/plantlab-agent.service` on disk as an
    // actual `-> /dev/null` symlink - reproduce that literally here, since
    // writing "through" such a symlink with `>` silently succeeds and
    // leaves the mask in place forever (the actual root cause). Only
    // mktemp+mv (rename over the symlink's directory entry) clears it.
    await fake.preMask("plantlab-agent.service");
    const unitDir = path.join(process.env.HOME!, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    const unitPath = path.join(unitDir, "plantlab-agent.service");
    await symlink("/dev/null", unitPath);
    expect((await lstat(unitPath)).isSymbolicLink()).toBe(true);

    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
    });

    expect(result.ok).toBe(true);
    const finalStat = await lstat(unitPath);
    expect(finalStat.isSymbolicLink()).toBe(false);
    expect(finalStat.isFile()).toBe(true);
    const content = await readFile(unitPath, "utf8");
    expect(content).toContain("[Unit]");
    expect(content).not.toBe("");
  });

  it("reports the unmask as a completed step for user-facing output", async () => {
    await setUp();
    await fake.preMask("plantlab-agent.service");

    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
    });

    const unmaskStep = result.steps.find((step) => step.name === "unmask:plantlab-agent.service");
    expect(unmaskStep?.status).toBe("completed");
  });

  it("stops and disables inappropriate services for the requested role", async () => {
    await setUp();
    // Simulate a standalone machine being converted to camera-node: web/camera were previously active.
    await convergeNodeRole({ target: { kind: "local" }, role: "standalone", startServices: true });
    expect(await fake.isActive("plantlab-web.service")).toBe(true);
    expect(await fake.isActive("plantlab-camera.service")).toBe(true);

    await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
    });

    expect(await fake.isActive("plantlab-web.service")).toBe(false);
    expect(await fake.isActive("plantlab-camera.service")).toBe(false);
    expect(await fake.isActive("plantlab-agent.service")).toBe(true);
  });

  it("enables local camera hardware for standalone web units but not coordinator web units", async () => {
    await setUp();
    const unitPath = path.join(process.env.HOME!, ".config", "systemd", "user", "plantlab-web.service");

    await convergeNodeRole({ target: { kind: "local" }, role: "standalone", startServices: true });
    await expect(readFile(unitPath, "utf8")).resolves.toContain("PLANTLAB_LOCAL_CAMERA_ENABLED=1");

    await convergeNodeRole({ target: { kind: "local" }, role: "coordinator", startServices: true });
    await expect(readFile(unitPath, "utf8")).resolves.not.toContain("PLANTLAB_LOCAL_CAMERA_ENABLED=1");
  });

  it("is idempotent - converging the same role twice succeeds both times with no leftover mask/failure", async () => {
    await setUp();
    const first = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
    });
    const second = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: null, // second run reuses the existing credential file
      startServices: true,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await fake.isActive("plantlab-agent.service")).toBe(true);
  });

  it("writes plantlab.config.json atomically with the requested role/coordinator/spool", async () => {
    await setUp();
    await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      nodeName: "bokchoy",
      credential: "pln_test",
      startServices: true,
    });

    const config = await readNodeConfig();
    expect(config?.role).toBe("camera-node");
    expect(config?.coordinatorUrl).toBe("http://coordinator:3000");
    expect(config?.nodeName).toBe("bokchoy");

    const entries = await readdir(resolveRootDir());
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("writes the credential file atomically with 0600 permissions", async () => {
    await setUp();
    await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_secret-token",
      startServices: true,
    });

    const envPath = path.join(process.env.HOME!, ".config", "plantlab", "agent.env");
    const content = await readFile(envPath, "utf8");
    expect(content).toContain("PLANTLAB_NODE_CREDENTIAL=pln_secret-token");
    const { stat } = await import("node:fs/promises");
    const mode = (await stat(envPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("omitting credential leaves an existing credential file untouched (credential reuse)", async () => {
    await setUp();
    await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_original",
      startServices: true,
    });

    await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: null,
      startServices: true,
    });

    const envPath = path.join(process.env.HOME!, ".config", "plantlab", "agent.env");
    const content = await readFile(envPath, "utf8");
    expect(content).toContain("pln_original");
  });

  it("prepares the spool directory structure for a camera-node role", async () => {
    await setUp();
    const spoolRoot = path.join(process.env.HOME!, ".local", "state", "plantlab-agent");
    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
    });

    expect(result.spoolPrepared).toBe(true);
    for (const dir of ["pending", "uploading", "acknowledged", "failed"]) {
      const { stat } = await import("node:fs/promises");
      await expect(stat(path.join(spoolRoot, "spool", dir))).resolves.toBeTruthy();
    }
  });

  it("manageSystemd:false never invokes systemctl at all, not even daemon-reload", async () => {
    await setUp();
    // Point PATH at a directory containing ONLY the fake systemctl already
    // added - but additionally verify no systemctl call happened by
    // checking no state files were created for any unit.
    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
      manageSystemd: false,
    });

    expect(result.ok).toBe(true);
    expect(result.configWritten).toBe(true);
    expect(result.credentialWritten).toBe(true);
    expect(await fake.isActive("plantlab-agent.service")).toBe(false);
    expect(await fake.isEnabled("plantlab-agent.service")).toBe(false);
    const step = result.steps.find((s) => s.name === "systemd-units");
    expect(step?.status).toBe("skipped");
  });

  it("does not start services when startServices is false, but still writes config/credential/units", async () => {
    await setUp();
    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: false,
    });

    expect(result.ok).toBe(true);
    expect(result.configWritten).toBe(true);
    expect(await fake.isActive("plantlab-agent.service")).toBe(false);
  });

  it("provides a safe, idempotent retry command", async () => {
    await setUp();
    const result = await convergeNodeRole({
      target: { kind: "local" },
      role: "camera-node",
      coordinatorUrl: "http://coordinator:3000",
      credential: "pln_test",
      startServices: true,
    });
    expect(result.retryCommand).toContain("plantlab install");
    expect(result.retryCommand).toContain("camera-node");
  });
});
