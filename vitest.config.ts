import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["extensions/**/*.ts", "skills/**/*.md"],
    },
  },
});
