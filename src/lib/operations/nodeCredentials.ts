import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { NodeRole } from "./config";

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/operations/nodeCredentials.ts handles coordinator credentials - it must never be imported from a browser.",
  );
}

export type RegisterNodeInput = {
  name: string;
  hostname?: string | null;
  role: NodeRole | "camera-node" | "coordinator" | "standalone";
  operatingSystem?: string | null;
  architecture?: string | null;
  softwareVersion?: string | null;
  coordinatorUrl?: string | null;
  rotateCredential?: boolean;
};

export type RegisterNodeResult = {
  node: {
    id: string;
    name: string;
    role: string;
    hostname: string | null;
  };
  credential: string;
  credentialHash: string;
  rotated: boolean;
};

const CREDENTIAL_PREFIX = "pln_";

export function generateNodeCredential(): string {
  return `${CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashNodeCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function timingSafeHashEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function registerOrRotateNode(prisma: PrismaClient, input: RegisterNodeInput): Promise<RegisterNodeResult> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Node name is required.");
  }

  const credential = generateNodeCredential();
  const credentialHash = hashNodeCredential(credential);
  const now = new Date();

  const node = await prisma.plantLabNode.upsert({
    where: { name },
    create: {
      name,
      hostname: input.hostname ?? name,
      role: input.role,
      status: "enrolled",
      operatingSystem: input.operatingSystem ?? null,
      architecture: input.architecture ?? null,
      softwareVersion: input.softwareVersion ?? null,
      coordinatorUrl: input.coordinatorUrl ?? null,
    },
    update: {
      hostname: input.hostname ?? name,
      role: input.role,
      status: "enrolled",
      operatingSystem: input.operatingSystem ?? null,
      architecture: input.architecture ?? null,
      softwareVersion: input.softwareVersion ?? null,
      coordinatorUrl: input.coordinatorUrl ?? null,
    },
    select: { id: true, name: true, role: true, hostname: true },
  });

  if (input.rotateCredential) {
    await prisma.nodeCredential.updateMany({
      where: { nodeId: node.id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  const existingActive = await prisma.nodeCredential.findFirst({
    where: { nodeId: node.id, revokedAt: null },
    select: { credentialHash: true },
    orderBy: { createdAt: "desc" },
  });

  if (existingActive && !input.rotateCredential) {
    return { node, credential: "", credentialHash: existingActive.credentialHash, rotated: false };
  }

  await prisma.nodeCredential.create({
    data: {
      nodeId: node.id,
      credentialHash,
    },
  });

  return { node, credential, credentialHash, rotated: true };
}

export type AuthenticatedNode = {
  node: {
    id: string;
    name: string;
    role: string;
    hostname: string | null;
  };
  credentialId: string;
};

export async function authenticateNodeCredential(
  prisma: PrismaClient,
  authorizationHeader: string | null,
): Promise<AuthenticatedNode | null> {
  const match = /^Bearer\s+(.+)$/i.exec((authorizationHeader ?? "").trim());
  if (!match) {
    return null;
  }

  const supplied = match[1].trim();
  if (!supplied) {
    return null;
  }

  const suppliedHash = hashNodeCredential(supplied);
  const credential = await prisma.nodeCredential.findUnique({
    where: { credentialHash: suppliedHash },
    include: { node: { select: { id: true, name: true, role: true, hostname: true } } },
  });

  if (!credential || credential.revokedAt) {
    return null;
  }

  await prisma.nodeCredential.update({
    where: { id: credential.id },
    data: { lastUsedAt: new Date() },
  });

  return { node: credential.node, credentialId: credential.id };
}
