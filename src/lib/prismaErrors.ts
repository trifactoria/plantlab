/** True for a Prisma unique-constraint violation (error code P2002). */
export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002",
  );
}
