import { PrismaClient } from "@prisma/client";

// Under Vitest (`process.env.VITEST` is set automatically by the test
// runner), a DATABASE_URL that doesn't look like an isolated test database
// is a hard failure rather than a silent connection to the real
// development database. See tests/unit/setup/testEnvironment.ts, which
// sets an isolated DATABASE_URL before any test file's own imports run -
// if this throws, that setup file isn't registered/running for the code
// path that hit it.
if (process.env.VITEST && !/plantlab-test/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error(
    "Refusing to create a Prisma client under Vitest with a DATABASE_URL that doesn't look " +
      `like an isolated test database (got: ${JSON.stringify(process.env.DATABASE_URL)}). ` +
      "Tests must not touch the real development database. See tests/unit/setup/testEnvironment.ts.",
  );
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
