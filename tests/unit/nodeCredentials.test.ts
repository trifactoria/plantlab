import { describe, expect, it } from "vitest";
import { authenticateNodeCredential, hashNodeCredential, registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
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
});
