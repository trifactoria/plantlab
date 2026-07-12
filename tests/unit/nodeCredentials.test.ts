import { describe, expect, it } from "vitest";
import {
  authenticateNodeCredential,
  computeNodeStatus,
  hasActiveCredential,
  hashNodeCredential,
  markNodeStatus,
  registerOrRotateNode,
} from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

describe("node credentials", () => {
  it("hashes credentials without storing raw values and authenticates active credentials", async () => {
    const result = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });

    expect(result.credential).toMatch(/^pln_/);
    expect(result.credentialHash).toBe(hashNodeCredential(result.credential));
    expect(result.credentialHash).not.toContain(result.credential);

    const stored = await prisma.nodeCredential.findFirstOrThrow({ where: { nodeId: result.node.id } });
    expect(stored.credentialHash).toBe(result.credentialHash);

    const auth = await authenticateNodeCredential(prisma, `Bearer ${result.credential}`);
    expect(auth?.node.name).toBe("xps");
  });

  it("is idempotent for node records and supports credential rotation", async () => {
    const first = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });
    const second = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });

    expect(second.node.id).toBe(first.node.id);
    expect(second.credentialHash).not.toBe(first.credentialHash);
    await expect(authenticateNodeCredential(prisma, `Bearer ${first.credential}`)).resolves.toBeNull();
    await expect(authenticateNodeCredential(prisma, `Bearer ${second.credential}`)).resolves.toMatchObject({
      node: { name: "xps" },
    });
  });

  it("reuses an active credential when attach is rerun without rotation", async () => {
    const first = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });
    const second = await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: false });

    expect(second.node.id).toBe(first.node.id);
    expect(second.rotated).toBe(false);
    expect(second.credential).toBe("");
    expect(second.credentialHash).toBe(first.credentialHash);
    await expect(authenticateNodeCredential(prisma, `Bearer ${first.credential}`)).resolves.toMatchObject({
      node: { name: "xps" },
    });
  });

  it("registers a brand-new node as pending, never active - a freshly registered node must never display as healthy before it has ever heartbeated", async () => {
    const result = await registerOrRotateNode(prisma, { name: "fresh-node", role: "camera-node", rotateCredential: true });
    expect(result.node.status).toBe("pending");
    expect(result.node.lastHeartbeatAt).toBeNull();
  });

  it("does not reset status on re-registration - a repair-required flag survives a credential-repair re-registration", async () => {
    const first = await registerOrRotateNode(prisma, { name: "flaky-node", role: "camera-node", rotateCredential: true });
    await markNodeStatus(prisma, first.node.id, "repair-required");

    const second = await registerOrRotateNode(prisma, { name: "flaky-node", role: "camera-node", rotateCredential: false });
    const stored = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: second.node.id } });
    expect(stored.status).toBe("repair-required");
  });

  describe("computeNodeStatus", () => {
    it("reports revoked when there is no active credential, regardless of stored status or heartbeat", () => {
      const status = computeNodeStatus({ status: "online", lastHeartbeatAt: new Date() }, false);
      expect(status).toBe("revoked");
    });

    it("reports repair-required when explicitly flagged, even with an active credential", () => {
      const status = computeNodeStatus({ status: "repair-required", lastHeartbeatAt: null }, true);
      expect(status).toBe("repair-required");
    });

    it("reports pending for a node that has never heartbeated", () => {
      const status = computeNodeStatus({ status: "online", lastHeartbeatAt: null }, true);
      expect(status).toBe("pending");
    });

    it("reports active for a recent heartbeat", () => {
      const status = computeNodeStatus({ status: "online", lastHeartbeatAt: new Date() }, true);
      expect(status).toBe("active");
    });

    it("reports offline for a stale heartbeat", () => {
      const status = computeNodeStatus(
        { status: "online", lastHeartbeatAt: new Date("2020-01-01T00:00:00Z") },
        true,
        new Date("2026-01-01T00:00:00Z"),
      );
      expect(status).toBe("offline");
    });
  });

  describe("markNodeStatus / hasActiveCredential", () => {
    it("hasActiveCredential is false before any credential exists and true after registration", async () => {
      const node = await prisma.plantLabNode.create({ data: { name: "no-credential-yet", role: "camera-node", status: "pending" } });
      await expect(hasActiveCredential(prisma, node.id)).resolves.toBe(false);

      const registered = await registerOrRotateNode(prisma, { name: "no-credential-yet", role: "camera-node", rotateCredential: true });
      await expect(hasActiveCredential(prisma, registered.node.id)).resolves.toBe(true);
    });

    it("hasActiveCredential is false again after the credential is revoked (rotated)", async () => {
      const first = await registerOrRotateNode(prisma, { name: "rotate-me", role: "camera-node", rotateCredential: true });
      await prisma.nodeCredential.updateMany({ where: { nodeId: first.node.id }, data: { revokedAt: new Date() } });
      await expect(hasActiveCredential(prisma, first.node.id)).resolves.toBe(false);
    });

    it("markNodeStatus updates only the status field", async () => {
      const registered = await registerOrRotateNode(prisma, { name: "status-target", role: "camera-node", rotateCredential: true });
      await markNodeStatus(prisma, registered.node.id, "repair-required");
      const stored = await prisma.plantLabNode.findUniqueOrThrow({ where: { id: registered.node.id } });
      expect(stored.status).toBe("repair-required");
      expect(stored.role).toBe("camera-node");
    });
  });
});
