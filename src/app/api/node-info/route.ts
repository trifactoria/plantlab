import os from "node:os";
import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";
import { readNodeConfig } from "@/lib/operations/config";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const config = await readNodeConfig();
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const node = config?.nodeName
    ? await prisma.plantLabNode.findUnique({ where: { name: config.nodeName }, select: { id: true, name: true } })
    : null;

  return NextResponse.json({
    coordinatorName: config?.nodeName ?? os.hostname(),
    version: packageJson.version,
    nodeId: node?.id ?? null,
    role: config?.role ?? "not-configured",
    apiCompatibilityVersion: 1,
    baseUrl,
    health: "ok",
    ingestAvailable: true,
  });
}
