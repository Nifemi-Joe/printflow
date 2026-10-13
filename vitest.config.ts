import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // Everything that touches PostgreSQL shares one test database, so these
        // files run one at a time (never in parallel with each other).
        esbuild: { target: "es2022" },
        test: {
          name: "db",
          include: ["db/test/**/*.test.ts", "apps/worker/test/**/*.test.ts", "apps/api/test/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
