import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { authenticateNodeCredential } from "../../../src/lib/operations/nodeCredentials";

/**
 * A minimal real HTTP server implementing exactly the
 * `POST /api/agents/credential-check` contract (see
 * src/app/api/agents/credential-check/route.ts) - reuses the real
 * authenticateNodeCredential() against the test's isolated Prisma client,
 * so probeRemoteCredential() tests exercise the actual auth logic end to
 * end (via a real curl call from the fake-ssh "remote" shell) rather than
 * a hand-rolled stand-in. Not the full Next.js app - just this one route,
 * which is all probeRemoteCredential() ever calls.
 */
export type FakeCoordinatorServer = {
  url: string;
  close: () => Promise<void>;
};

export async function startFakeCoordinatorServer(prisma: PrismaClient): Promise<FakeCoordinatorServer> {
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/agents/credential-check") {
      authenticateNodeCredential(prisma, req.headers.authorization ?? null)
        .then((auth) => {
          if (!auth) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, node: { name: auth.node.name, role: auth.node.role } }));
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Internal error" }));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
