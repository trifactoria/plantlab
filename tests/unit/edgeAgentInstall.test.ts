import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyEdgeAgentDirectory,
  edgeAgentInstallChangeStatus,
  localEdgeAgentVersion,
  readInstalledEdgeAgentVersion,
  runEdgeAgentInstall,
} from "../../src/lib/operations/edgeAgentInstall";
import { createFakeRemoteHome, createFakeSsh, type FakeSsh } from "./helpers/fakeSsh";

async function exists(file: string) {
  return access(file).then(() => true, () => false);
}

describe("edge-agent install mirror", () => {
  let ssh: FakeSsh;
  let remoteHome: { home: string; cleanup: () => Promise<void> };
  let fakeBin: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    ssh = await createFakeSsh();
    remoteHome = await createFakeRemoteHome();
    fakeBin = await mkdtemp(path.join(os.tmpdir(), "plantlab-edge-install-bin-"));
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    process.env.HOME = remoteHome.home;
    process.env.PATH = [ssh.binDir, fakeBin, originalPath].filter(Boolean).join(path.delimiter);

    for (const command of ["ffmpeg", "v4l2-ctl", "systemctl", "loginctl"]) {
      await writeFile(path.join(fakeBin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await ssh.cleanup();
    await remoteHome.cleanup();
    await rm(fakeBin, { recursive: true, force: true }).catch(() => undefined);
  });

  it("reinstall mirrors the source package, removes stale Python files, and preserves config, credentials, spool, and logs", async () => {
    const installRoot = path.join(remoteHome.home, ".local", "share", "plantlab-edge-agent");
    const installedPackage = path.join(installRoot, "plantlab_edge_agent");
    const configDir = path.join(remoteHome.home, ".config", "plantlab");
    const spoolRoot = path.join(remoteHome.home, ".local", "state", "plantlab-edge-agent");

    await mkdir(path.join(installedPackage, "__pycache__"), { recursive: true });
    await writeFile(path.join(installedPackage, "stale_old_module.py"), "OLD = True\n");
    await writeFile(path.join(installedPackage, "__pycache__", "stale.pyc"), "old bytecode");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "edge-agent.json"), '{"coordinatorUrl":"http://old","spoolRoot":"keep"}\n');
    await writeFile(path.join(configDir, "agent.env"), "PLANTLAB_NODE_CREDENTIAL=keep\n");
    await mkdir(path.join(spoolRoot, "spool", "pending"), { recursive: true });
    await mkdir(path.join(spoolRoot, "logs"), { recursive: true });
    await writeFile(path.join(spoolRoot, "spool", "pending", "capture.json"), "{}\n");
    await writeFile(path.join(spoolRoot, "logs", "edge.log"), "keep\n");

    const source = await localEdgeAgentVersion();
    const copy = await copyEdgeAgentDirectory("greenhouse-zero");
    expect(copy.status).toBe(0);
    const install = await runEdgeAgentInstall("greenhouse-zero", {
      role: "greenhouse-node",
      nodeName: "greenhouse-zero",
      coordinatorUrl: "http://coordinator:3000",
    });
    expect(install.status).toBe(0);
    expect(install.stdout).toContain("PASS: package mirrored exactly");

    expect(await exists(path.join(installedPackage, "stale_old_module.py"))).toBe(false);
    expect(await exists(path.join(installedPackage, "__pycache__"))).toBe(false);
    expect(await readFile(path.join(configDir, "edge-agent.json"), "utf8")).toContain("http://old");
    expect(await readFile(path.join(configDir, "agent.env"), "utf8")).toContain("PLANTLAB_NODE_CREDENTIAL=keep");
    expect(await readFile(path.join(spoolRoot, "spool", "pending", "capture.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(spoolRoot, "logs", "edge.log"), "utf8")).toBe("keep\n");

    const installed = await readInstalledEdgeAgentVersion("greenhouse-zero");
    expect(installed?.version).toBe(source.version);
    expect(installed?.contentHash).toBe(source.contentHash);
    expect(edgeAgentInstallChangeStatus(source, null)).toBe("UPDATED");
    expect(edgeAgentInstallChangeStatus(source, installed)).toBe("UNCHANGED");
  });
});
