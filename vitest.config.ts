import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    // Builds one shared SQLite schema template once for the whole run.
    globalSetup: ["./tests/unit/setup/globalSetup.ts"],
    // Points PLANTLAB_ROOT_DIR/DATABASE_URL at a fresh isolated copy of
    // that template before each test file's own imports run - see
    // tests/unit/setup/testEnvironment.ts for why this can't be a
    // beforeAll/afterAll hook instead.
    setupFiles: ["./tests/unit/setup/testEnvironment.ts"],
  },
});
