import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup-env.ts"],
    globals: true,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["extensions/**/*.ts", "skills/**/*.md"],
      thresholds: {
        statements: 70,
        branches: 80,
        functions: 85,
        lines: 70,
        "extensions/llm-wiki/index.ts": {
          statements: 55,
          branches: 50,
          functions: 50,
          lines: 55,
        },
        "extensions/llm-wiki/lib/knowledge-document.ts": {
          statements: 90,
          branches: 85,
          functions: 85,
          lines: 90,
        },
        "extensions/llm-wiki/lib/vault-format.ts": {
          statements: 85,
          branches: 80,
          functions: 90,
          lines: 85,
        },
      },
    },
  },
});
