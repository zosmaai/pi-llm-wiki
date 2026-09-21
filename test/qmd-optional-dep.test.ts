import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Issue #264: @tobilu/qmd is an optional dependency because its native
// subtree (better-sqlite3@12) fails to install without GitHub access or C++
// build tools. A static VALUE import in production code would break installs
// where npm skipped the subtree. Pin the import shape so a future refactor
// can't silently regress it. Type-only and dynamic imports are fine.
describe("@tobilu/qmd optional dependency guard", () => {
  const root = new URL("../", import.meta.url);
  const libDir = new URL("extensions/llm-wiki/lib/", root);
  const files = [
    "extensions/llm-wiki/index.ts",
    ...readdirSync(libDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `extensions/llm-wiki/lib/${f}`),
  ];
  const sources = files.map((f) => ({
    file: f,
    src: readFileSync(new URL(f, root), "utf8"),
  }));

  it("no production module has a static value import of @tobilu/qmd", () => {
    const offenders = sources.filter(
      // A `import { ... } from "@tobilu/qmd"` with a value binding —
      // `import type` is excluded by the lookahead.
      ({ src }) => /^import\s+(?!type\b)[^;]*?from\s*["']@tobilu\/qmd["']/m.test(src),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("qmd-store.ts loads @tobilu/qmd dynamically", () => {
    const src = sources.find(({ file }) => file.endsWith("qmd-store.ts"))!.src;
    expect(src).toMatch(/import\(\s*["']@tobilu\/qmd["']\s*\)/);
  });
});
