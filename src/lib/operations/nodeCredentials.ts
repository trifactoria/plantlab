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
    status: string;
    lastHeartbeatAt: Date | null;
  };
  credential: string;
  credentialHash: string;
  rotated: boolean;
};

const CREDENTIAL_PREFIX = "pln_";

/**
 * The vocabulary required by DEPLOYMENT.md "Coordinator enrollment state" -
 * a computed/derived label, never stored verbatim as PlantLabNode.status
 * (which stays a free-form string so introducing a new label never needs a
 * migration). "repair-required" is the one label that IS driven directly by
 * the stored status field (set explicitly by markNodeStatus() at a
 * well-defined point in the attach/repair flow); every other label is
 * derived from credential + heartbeat state so it can never go stale.
 */
export const NODE_STATUS_LABELS = ["pending", "active", "repair-required", "revoked", "offline"] as const;
export type NodeStatusLabel = (typeof NODE_STATUS_LABELS)[number];

const STALE_HEARTBEAT_MS = 5 * 60_000;

export function computeNodeStatus(
  node: { status: string; lastHeartbeatAt: Date | null },
  hasActiveCredential: boolean,
  now: Date = new Date(),
): NodeStatusLabel {
  if (!hasActiveCredential) {
    return "revoked";
  }
  if (node.status === "repair-required") {
    return "repair-required";
  }
  if (!node.lastHeartbeatAt) {
    return "pending";
  }
  const ageMs = now.getTime() - node.lastHeartbeatAt.getTime();
  return ageMs > STALE_HEARTBEAT_MS ? "offline" : "active";
}

/**
 * Explicit status transitions for the attach/repair flow - see
 * DEPLOYMENT.md "Coordinator enrollment state". Never called from the
 * heartbeat/inventory endpoints themselves (those only ever touch
 * lastHeartbeatAt - see recordHeartbeat() in agentProtocol.ts); this is
 * only for marking the *human-initiated* enrollment/repair lifecycle.
 */
export async function markNodeStatus(prisma: PrismaClient, nodeId: string, status: "pending" | "repair-required"): Promise<void> {
  await prisma.plantLabNode.update({ where: { id: nodeId }, data: { status } });
}

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
      // "pending" until the first heartbeat arrives - see computeNodeStatus()
      // below. Never "active"/"enrolled" at creation time: a freshly
      // registered credential does not mean the remote node is actually
      // configured and running yet (see DEPLOYMENT.md "Coordinator
      // enrollment state" - a partially attached node must never display
      // as healthy).
      status: "pending",
      operatingSystem: input.operatingSystem ?? null,
      architecture: input.architecture ?? null,
      softwareVersion: input.softwareVersion ?? null,
      coordinatorUrl: input.coordinatorUrl ?? null,
    },
    update: {
      hostname: input.hostname ?? name,
      role: input.role,
      // status is intentionally NOT reset here - re-registering a
      // credential (e.g. a retried attach, or a doctor --fix repair) must
      // not silently erase a "repair-required" flag set by a previous
      // failed attempt, nor downgrade an already-"active" node. Status
      // transitions happen explicitly via markNodeStatus() at well-defined
      // points in the attach/repair flow instead.
      operatingSystem: input.operatingSystem ?? null,
      architecture: input.architecture ?? null,
      softwareVersion: input.softwareVersion ?? null,
      coordinatorUrl: input.coordinatorUrl ?? null,
    },
    select: { id: true, name: true, role: true, hostname: true, status: true, lastHeartbeatAt: true },
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

/** Used by computeNodeStatus() callers (doctor, node info/list) - true if the node has at least one non-revoked credential. */
export async function hasActiveCredential(prisma: PrismaClient, nodeId: string): Promise<boolean> {
  const existing = await prisma.nodeCredential.findFirst({
    where: { nodeId, revokedAt: null },
    select: { id: true },
  });
  return existing !== null;
}
