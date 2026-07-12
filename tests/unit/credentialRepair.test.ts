import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import {
  ensureValidNodeCredential,
  probeRemoteCredential,
  rotateAndInstallCredential,
} from "../../src/lib/operations/credentialRepair";
import { createFakeSsh, createFakeRemoteHome, type FakeSsh } from "./helpers/fakeSsh";
import { createFakeSystemctl, prependPath, type FakeSystemctl } from "./helpers/fakeSystemctl";
import { startFakeCoordinatorServer, type FakeCoordinatorServer } from "./helpers/fakeCoordinatorServer";

/** The real bokchoy failure: registerOrRotateNode has an active credential hash on the coordinator, but the remote env file is missing/empty/malformed - simulated directly on the fake "remote" filesystem, not by going through convergeNodeRole first. */
function credentialPath(remoteHome: string): string {
  return path.join(remoteHome, ".config", "plantlab", "agent.env");
}

async function writeRemoteCredentialFile(remoteHome: string, content: string | null): Promise<void> {
  const dir = path.join(remoteHome, ".config", "plantlab");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (content !== null) {
    await writeFile(credentialPath(remoteHome), content, { mode: 0o600 });
  }
}

/** Simulates the agent's own heartbeat arriving asynchronously, since no real agent process runs in these tests - races against waitForNodeHeartbeat()'s poll loop. */
function simulateHeartbeatAfter(nodeId: string, delayMs: number): void {
  setTimeout(() => {
    prisma.plantLabNode.update({ where: { id: nodeId }, data: { status: "online", lastHeartbeatAt: new Date() } }).catch(() => undefined);
  }, delayMs);
}

describe("credentialRepair", () => {
  describe("probeRemoteCredential (Part 1)", () => {
    let ssh: FakeSsh;
    let remoteHome: { home: string; cleanup: () => Promise<void> };
    let restorePath: () => void;
    let originalHome: string | undefined;
    let server: FakeCoordinatorServer | null = null;

    afterEach(async () => {
      restorePath?.();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await ssh?.cleanup();
      await remoteHome?.cleanup();
      await server?.close();
      server = null;
    });

    async function setUp() {
      ssh = await createFakeSsh();
      restorePath = prependPath(ssh.binDir);
      remoteHome = await createFakeRemoteHome();
      originalHome = process.env.HOME;
      process.env.HOME = remoteHome.home;
    }

    it("reports missing when the credential file does not exist - the exact bokchoy failure mode", async () => {
      await setUp();
      const result = await probeRemoteCredential({ sshHost: "bokchoy", coordinatorUrl: "http://coordinator.invalid:3000" });
      expect(result.status).toBe("missing");
    });

    it("reports empty for a zero-byte credential file", async () => {
      await setUp();
      await writeRemoteCredentialFile(remoteHome.home, "");
      const result = await probeRemoteCredential({ sshHost: "bokchoy", coordinatorUrl: "http://coordinator.invalid:3000" });
      expect(result.status).toBe("empty");
    });

    it("reports var-missing for a non-empty file that never sets PLANTLAB_NODE_CREDENTIAL", async () => {
      await setUp();
      await writeRemoteCredentialFile(remoteHome.home, "SOME_OTHER_VAR=hello\n");
      const result = await probeRemoteCredential({ sshHost: "bokchoy", coordinatorUrl: "http://coordinator.invalid:3000" });
      expect(result.status).toBe("var-missing");
    });

    it("reports malformed for a value that doesn't look like a PlantLab credential", async () => {
      await setUp();
      await writeRemoteCredentialFile(remoteHome.home, "PLANTLAB_NODE_CREDENTIAL=not-a-real-token\n");
      const result = await probeRemoteCredential({ sshHost: "bokchoy", coordinatorUrl: "http://coordinator.invalid:3000" });
      expect(result.status).toBe("malformed");
    });

    it("reports valid for a credential that authenticates against a real coordinator endpoint", async () => {
      await setUp();
      server = await startFakeCoordinatorServer(prisma);
      const registered = await registerOrRotateNode(prisma, { name: "probe-valid-node", role: "camera-node", rotateCredential: true });
      await writeRemoteCredentialFile(remoteHome.home, `PLANTLAB_NODE_CREDENTIAL=${registered.credential}\n`);

      const result = await probeRemoteCredential({ sshHost: "probe-valid-node", coordinatorUrl: server.url });
      expect(result.status).toBe("valid");
    });

    it("reports rejected for a credential the coordinator has revoked (stale token)", async () => {
      await setUp();
      server = await startFakeCoordinatorServer(prisma);
      const registered = await registerOrRotateNode(prisma, { name: "probe-rejected-node", role: "camera-node", rotateCredential: true });
      await writeRemoteCredentialFile(remoteHome.home, `PLANTLAB_NODE_CREDENTIAL=${registered.credential}\n`);
      await prisma.nodeCredential.updateMany({ where: { credentialHash: registered.credentialHash }, data: { revokedAt: new Date() } });

      const result = await probeRemoteCredential({ sshHost: "probe-rejected-node", coordinatorUrl: server.url });
      expect(result.status).toBe("rejected");
    });

    it("never transmits the credential value back to the CLI process - only a status keyword", async () => {
      await setUp();
      server = await startFakeCoordinatorServer(prisma);
      const registered = await registerOrRotateNode(prisma, { name: "probe-no-leak-node", role: "camera-node", rotateCredential: true });
      await writeRemoteCredentialFile(remoteHome.home, `PLANTLAB_NODE_CREDENTIAL=${registered.credential}\n`);

      const result = await probeRemoteCredential({ sshHost: "probe-no-leak-node", coordinatorUrl: server.url });
      expect(JSON.stringify(result)).not.toContain(registered.credential);
    });
  });

  describe("rotateAndInstallCredential / ensureValidNodeCredential (Part 2, runtime: node)", () => {
    let ssh: FakeSsh;
    let fake: FakeSystemctl;
    let remoteHome: { home: string; cleanup: () => Promise<void> };
    let restorePath: () => void;
    let originalHome: string | undefined;
    let server: FakeCoordinatorServer;

    async function setUp() {
      ssh = await createFakeSsh();
      fake = await createFakeSystemctl();
      restorePath = prependPath(`${ssh.binDir}:${fake.binDir}`);
      remoteHome = await createFakeRemoteHome();
      originalHome = process.env.HOME;
      process.env.HOME = remoteHome.home;
      server = await startFakeCoordinatorServer(prisma);
    }

    afterEach(async () => {
      restorePath?.();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await ssh?.cleanup();
      await fake?.cleanup();
      await remoteHome?.cleanup();
      await server?.close();
    });

    it("automatically rotates when the remote credential is missing, and a fresh heartbeat proves success (the bokchoy repair)", async () => {
      await setUp();
      // No credential file at all on the "remote" - the exact bokchoy state:
      // coordinator has no prior registration yet either (fresh node), so
      // its id isn't known until registerOrRotateNode() runs *inside* the
      // call below. Start the call without awaiting it yet, poll for the
      // registration to land, then simulate the agent's first heartbeat -
      // mirroring a real agent starting up shortly after credential
      // install, before finally awaiting the original call's result.
      const repoPath = path.join(remoteHome.home, "projects", "plantlab");
      await mkdir(repoPath, { recursive: true });

      const resultPromise = ensureValidNodeCredential(prisma, {
        sshHost: "bokchoy",
        repoPath,
        coordinatorUrl: server.url,
        role: "camera-node",
        runtime: "node",
        nodeName: "bokchoy",
        spoolRoot: path.join(remoteHome.home, ".local", "state", "plantlab-agent"),
        registerInput: { name: "bokchoy", role: "camera-node" },
        heartbeatTimeoutMs: 8000,
      });

      let nodeId: string | null = null;
      for (let i = 0; i < 25 && !nodeId; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const node = await prisma.plantLabNode.findUnique({ where: { name: "bokchoy" } });
        if (node) nodeId = node.id;
      }
      expect(nodeId).not.toBeNull();
      await prisma.plantLabNode.update({ where: { id: nodeId! }, data: { status: "online", lastHeartbeatAt: new Date() } });

      const result = await resultPromise;
      expect(result.probe.status).toBe("missing");
      expect(result.rotated).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.node?.name).toBe("bokchoy");
    }, 15_000);

    it("wait-for-heartbeat is satisfied by a heartbeat armed before the call", async () => {
      await setUp();
      const repoPath = path.join(remoteHome.home, "projects", "plantlab");
      await mkdir(repoPath, { recursive: true });

      // Pre-register so we know the node id before calling rotate, and arm
      // the simulated heartbeat to fire shortly after the credential
      // install step completes.
      const preRegistered = await registerOrRotateNode(prisma, { name: "bokchoy-heartbeat", role: "camera-node", rotateCredential: true });
      simulateHeartbeatAfter(preRegistered.node.id, 300);

      const result = await rotateAndInstallCredential(prisma, {
        sshHost: "bokchoy-heartbeat",
        repoPath,
        coordinatorUrl: server.url,
        role: "camera-node",
        runtime: "node",
        nodeName: "bokchoy-heartbeat",
        spoolRoot: path.join(remoteHome.home, ".local", "state", "plantlab-agent"),
        registerInput: { name: "bokchoy-heartbeat", role: "camera-node" },
        heartbeatTimeoutMs: 8000,
        rotate: true,
      });

      expect(result.ok).toBe(true);
      expect(result.rotated).toBe(true);
      expect(result.steps.find((s) => s.name === "heartbeat")?.status).toBe("completed");

      const node = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: preRegistered.node.id } });
      expect(node.status).toBe("pending"); // cleared back from repair-required territory by markNodeStatus("pending")
    }, 15_000);

    it("writes a working credential file that a follow-up probe reports valid", async () => {
      await setUp();
      const repoPath = path.join(remoteHome.home, "projects", "plantlab");
      await mkdir(repoPath, { recursive: true });
      const preRegistered = await registerOrRotateNode(prisma, { name: "bokchoy-followup", role: "camera-node", rotateCredential: true });
      simulateHeartbeatAfter(preRegistered.node.id, 200);

      await rotateAndInstallCredential(prisma, {
        sshHost: "bokchoy-followup",
        repoPath,
        coordinatorUrl: server.url,
        role: "camera-node",
        runtime: "node",
        nodeName: "bokchoy-followup",
        spoolRoot: path.join(remoteHome.home, ".local", "state", "plantlab-agent"),
        registerInput: { name: "bokchoy-followup", role: "camera-node" },
        heartbeatTimeoutMs: 8000,
        rotate: true,
      });

      const probe = await probeRemoteCredential({ sshHost: "bokchoy-followup", coordinatorUrl: server.url });
      expect(probe.status).toBe("valid");
    }, 15_000);

    it("does not rotate when the existing credential already probes valid", async () => {
      await setUp();
      const repoPath = path.join(remoteHome.home, "projects", "plantlab");
      await mkdir(repoPath, { recursive: true });
      const registered = await registerOrRotateNode(prisma, { name: "already-valid-node", role: "camera-node", rotateCredential: true });
      await writeRemoteCredentialFile(remoteHome.home, `PLANTLAB_NODE_CREDENTIAL=${registered.credential}\n`);
      simulateHeartbeatAfter(registered.node.id, 200);

      const result = await ensureValidNodeCredential(prisma, {
        sshHost: "already-valid-node",
        repoPath,
        coordinatorUrl: server.url,
        role: "camera-node",
        runtime: "node",
        nodeName: "already-valid-node",
        spoolRoot: path.join(remoteHome.home, ".local", "state", "plantlab-agent"),
        registerInput: { name: "already-valid-node", role: "camera-node" },
        heartbeatTimeoutMs: 8000,
      });

      expect(result.probe.status).toBe("valid");
      expect(result.rotated).toBe(false);
      const fileContent = await import("node:fs/promises").then((fs) => fs.readFile(credentialPath(remoteHome.home), "utf8"));
      expect(fileContent).toContain(registered.credential);
    }, 15_000);

    it("never prints the raw credential in any step detail", async () => {
      await setUp();
      const repoPath = path.join(remoteHome.home, "projects", "plantlab");
      await mkdir(repoPath, { recursive: true });
      const preRegistered = await registerOrRotateNode(prisma, { name: "no-leak-in-steps", role: "camera-node", rotateCredential: true });
      simulateHeartbeatAfter(preRegistered.node.id, 200);

      const result = await rotateAndInstallCredential(prisma, {
        sshHost: "no-leak-in-steps",
        repoPath,
        coordinatorUrl: server.url,
        role: "camera-node",
        runtime: "node",
        nodeName: "no-leak-in-steps",
        spoolRoot: path.join(remoteHome.home, ".local", "state", "plantlab-agent"),
        registerInput: { name: "no-leak-in-steps", role: "camera-node" },
        heartbeatTimeoutMs: 8000,
        rotate: true,
      });

      const newCredential = await import("node:fs/promises").then((fs) => fs.readFile(credentialPath(remoteHome.home), "utf8"));
      const token = newCredential.trim().replace("PLANTLAB_NODE_CREDENTIAL=", "");
      expect(token).toMatch(/^pln_/);
      for (const step of result.steps) {
        expect(step.detail).not.toContain(token);
      }
    }, 15_000);
  });

  describe("rotateAndInstallCredential (runtime: python-edge - Part 13)", () => {
    let ssh: FakeSsh;
    let fake: FakeSystemctl;
    let remoteHome: { home: string; cleanup: () => Promise<void> };
    let restorePath: () => void;
    let originalHome: string | undefined;
    let server: FakeCoordinatorServer;

    async function setUp() {
      ssh = await createFakeSsh();
      fake = await createFakeSystemctl();
      restorePath = prependPath(`${ssh.binDir}:${fake.binDir}`);
      remoteHome = await createFakeRemoteHome();
      originalHome = process.env.HOME;
      process.env.HOME = remoteHome.home;
      server = await startFakeCoordinatorServer(prisma);
    }

    afterEach(async () => {
      restorePath?.();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await ssh?.cleanup();
      await fake?.cleanup();
      await remoteHome?.cleanup();
      await server?.close();
    });

    it("writes the credential to the edge agent's env file and restarts plantlab-edge-agent.service - never plantlab-agent.service", async () => {
      await setUp();
      await fake.preMask("plantlab-edge-agent.service"); // never touched - edge-agent credential install doesn't manage systemd unit files, only restarts

      const preRegistered = await registerOrRotateNode(prisma, { name: "greenhouse-zero", role: "greenhouse-node", rotateCredential: true });
      simulateHeartbeatAfter(preRegistered.node.id, 200);

      const result = await rotateAndInstallCredential(prisma, {
        sshHost: "greenhouse-zero",
        repoPath: "~/plantlab-edge-agent",
        coordinatorUrl: server.url,
        role: "greenhouse-node",
        runtime: "python-edge",
        nodeName: "greenhouse-zero",
        registerInput: { name: "greenhouse-zero", role: "greenhouse-node" },
        heartbeatTimeoutMs: 8000,
        rotate: true,
      });

      expect(result.ok).toBe(true);
      expect(result.steps.find((s) => s.name === "credential-write")?.status).toBe("completed");
      expect(result.steps.find((s) => s.name === "agent-restart")?.status).toBe("completed");
      expect(await fake.isActive("plantlab-edge-agent.service")).toBe(true);
      expect(await fake.isActive("plantlab-agent.service")).toBe(false);

      const content = await import("node:fs/promises").then((fs) => fs.readFile(credentialPath(remoteHome.home), "utf8"));
      expect(content).toContain("PLANTLAB_NODE_CREDENTIAL=pln_");
    }, 15_000);

    it("restarts the edge agent when explicitly asked, even without a credential rotation", async () => {
      await setUp();
      const preRegistered = await registerOrRotateNode(prisma, { name: "greenhouse-restart-only", role: "greenhouse-node", rotateCredential: true });
      simulateHeartbeatAfter(preRegistered.node.id, 200);

      const result = await rotateAndInstallCredential(prisma, {
        sshHost: "greenhouse-restart-only",
        repoPath: "~/plantlab-edge-agent",
        coordinatorUrl: server.url,
        role: "greenhouse-node",
        runtime: "python-edge",
        nodeName: "greenhouse-restart-only",
        registerInput: { name: "greenhouse-restart-only", role: "greenhouse-node" },
        heartbeatTimeoutMs: 8000,
        rotate: false,
        forceRestart: true,
      });

      expect(result.ok).toBe(true);
      expect(result.rotated).toBe(false);
      expect(result.steps.find((s) => s.name === "credential-write")?.detail).toMatch(/no new credential/i);
      expect(result.steps.find((s) => s.name === "agent-restart")?.status).toBe("completed");
      expect(await fake.isActive("plantlab-edge-agent.service")).toBe(true);
    }, 15_000);

    it("a follow-up probe against the edge agent's credential reports valid", async () => {
      await setUp();
      const preRegistered = await registerOrRotateNode(prisma, { name: "greenhouse-followup", role: "greenhouse-node", rotateCredential: true });
      simulateHeartbeatAfter(preRegistered.node.id, 200);

      await rotateAndInstallCredential(prisma, {
        sshHost: "greenhouse-followup",
        repoPath: "~/plantlab-edge-agent",
        coordinatorUrl: server.url,
        role: "greenhouse-node",
        runtime: "python-edge",
        nodeName: "greenhouse-followup",
        registerInput: { name: "greenhouse-followup", role: "greenhouse-node" },
        heartbeatTimeoutMs: 8000,
        rotate: true,
      });

      const probe = await probeRemoteCredential({ sshHost: "greenhouse-followup", coordinatorUrl: server.url });
      expect(probe.status).toBe("valid");
    }, 15_000);
  });
});
