# Custom Wiki Page Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to register custom page types via settings, so `wiki_ensure_page` supports project-specific taxonomies alongside the 7 built-in types.

**Architecture:** Add `customTypes` to `TaskConfig` (existing settings surface). At runtime, merge custom types into `wiki_ensure_page`'s folder map. Custom types get a generic page template (no per-type templates — YAGNI). Works transparently for both pi and oh-my-pi via the existing `settings.json` / `config.yml` pipeline.

**Tech Stack:** TypeScript, Vitest

**Roadmap:** None

**Phase:** Single-plan implementation

---

## File Map

| File | Change |
|------|--------|
| `extensions/llm-wiki/lib/task-config.ts:33` | Add `customTypes` field to `TaskConfig` interface |
| `extensions/llm-wiki/lib/task-config.ts:225` | Add parsing block in `readNamespacedConfig` |
| `extensions/llm-wiki/lib/task-config.ts:488` | Add `"customTypes"` to `KNOWN_KEYS` array |
| `extensions/llm-wiki/lib/tools.ts:520` | Update type parameter description |
| `extensions/llm-wiki/lib/tools.ts:540` | Merge config custom types into `folderMap` |
| `test/custom-types.test.ts` | New test file for custom type behavior |

---

## Task 1: Add `customTypes` to TaskConfig

**Files:**
- Modify: `extensions/llm-wiki/lib/task-config.ts:33-165` (interface)
- Modify: `extensions/llm-wiki/lib/task-config.ts:225-320` (readNamespacedConfig)
- Modify: `extensions/llm-wiki/lib/task-config.ts:488` (KNOWN_KEYS)

- [ ] **Step 1: Add the field to TaskConfig interface**

Insert after the `wikilinkValidation` field (line ~165):

```ts
  /**
   * User-defined page types for wiki_ensure_page (issue #169). Merges with
   * the 7 built-in types (entity, concept, synthesis, analysis, requirement,
   * skill, case). Each key is the type name; each value is the folder name
   * inside wiki/. Example: { "decision": "decisions", "metric": "metrics" }
   * → wiki_ensure_page(type="decision") creates wiki/decisions/<slug>.md.
   * Custom types use a generic page template (no per-type templates).
   */
  customTypes?: Record<string, string>;
```

- [ ] **Step 2: Add parsing in `readNamespacedConfig`**

Insert before the `return out;` line (line ~318), after the `wikilinkValidation` block:

```ts
    const ct = section.customTypes;
    if (ct && typeof ct === "object" && !Array.isArray(ct)) {
      const entries = Object.entries(ct as Record<string, unknown>);
      const valid: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (typeof k === "string" && typeof v === "string" && k && v) {
          valid[k] = v;
        }
      }
      if (Object.keys(valid).length) out.customTypes = valid;
    }
```

This validates that customTypes is a flat `Record<string, string>` — rejects arrays, nested objects, and non-string values.

- [ ] **Step 3: Add to KNOWN_KEYS**

In the `KNOWN_KEYS` array (line ~488), add `"customTypes"` after `"wikilinkValidation"`:

```ts
const KNOWN_KEYS = [
  "taskModel",
  "embeddingProvider",
  "embeddingModel",
  "embeddingBaseUrl",
  "embeddingApiKey",
  "embeddingApiKeyEnv",
  "semanticWeight",
  "recallLinksThreshold",
  "recallSkillInlineMax",
  "notices",
  "ambientPersonalVault",
  "trajectories",
  "synthesisLanguage",
  "synthesisMaxTokens",
  "wikilinkValidation",
  "customTypes",
] as const;
```

- [ ] **Step 4: Commit**

```bash
git add extensions/llm-wiki/lib/task-config.ts
git commit -m "feat(config): add customTypes to TaskConfig with readNamespacedConfig parsing"
```

---

## Task 2: Merge custom types into wiki_ensure_page

**Files:**
- Modify: `extensions/llm-wiki/lib/tools.ts:520` (type description)
- Modify: `extensions/llm-wiki/lib/tools.ts:540-564` (folderMap + type cast)

- [ ] **Step 1: Load config and merge folderMap**

Replace the hardcoded `folderMap` and type cast (lines ~540-564) with:

```ts
      const config = loadTaskConfig(ctx.cwd);
      const builtInFolderMap: Record<string, string> = {
        entity: "entities",
        concept: "concepts",
        synthesis: "syntheses",
        analysis: "analyses",
        requirement: "requirements",
        skill: "skills",
        case: "cases",
      };
      const folderMap = { ...builtInFolderMap, ...config.customTypes };
      const type = params.type as string;
      const slug = slugify(params.title);
```

Remove the old `const type = params.type as "entity" | "concept" | ...` cast — it's now just `string` since custom types are valid.

- [ ] **Step 2: Update the type parameter description**

Replace the hardcoded type description (line ~520):

```ts
      type: Type.String({
        description:
          "Page type: entity | concept | synthesis | analysis | requirement | skill | case (built-in) or any user-defined type from llm-wiki.customTypes config",
      }),
```

- [ ] **Step 3: Verify buildPageBody fallback**

`buildPageBody` already has a generic fallback at the end (after the `requirement` block) that returns a basic template for any unrecognized type. No code change needed — custom types hit this existing fallback. Just verify it exists by reading the function end.

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `pnpm test`
Expected: All 699+ tests pass

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/tools.ts
git commit -m "feat(wiki_ensure_page): merge customTypes from config into folder map"
```

---

## Task 3: Tests for custom types

**Files:**
- Create: `test/custom-types.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWikiEnsurePage } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

interface Tool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    s: undefined,
    u: undefined,
    ctx: unknown,
  ) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
}

function capture(fn: (pi: ExtensionAPI) => void): Tool {
  let tool: Tool | undefined;
  const pi = {
    registerTool: (def: unknown) => {
      tool = def as Tool;
    },
  } as unknown as ExtensionAPI;
  fn(pi);
  if (!tool) throw new Error("tool not registered");
  return tool;
}

let wikiDir: string;

beforeEach(() => {
  wikiDir = join(
    import.meta.dirname,
    "..",
    "tmp",
    `ct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const llm = join(wikiDir, ".llm-wiki");
  for (const d of ["wiki/entities", "wiki/concepts", "wiki/sources", "meta", "outputs"]) {
    mkdirSync(join(llm, d), { recursive: true });
  }
  writeFileSync(join(llm, "config.json"), JSON.stringify({ topic: "Test", mode: "personal" }));
  ensureVaultStructure(getVaultPaths(wikiDir));
  writeFileSync(
    join(llm, "meta", "registry.json"),
    JSON.stringify({ version: "1.0", last_updated: "", pages: {} }),
  );
});

afterEach(() => {
  try {
    rmSync(wikiDir, { recursive: true, force: true });
  } catch {}
});

function writeSettings(customTypes: Record<string, string>): void {
  const cfg = join(wikiDir, ".pi");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    join(cfg, "settings.json"),
    JSON.stringify({ "llm-wiki": { customTypes } }),
  );
}

describe("wiki_ensure_page custom types", () => {
  it("creates a custom type in the correct folder", async () => {
    writeSettings({ decision: "decisions" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "decision", title: "Auth Architecture" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "decisions", "auth-architecture.md");
    expect(existsSync(expected)).toBe(true);
    expect(res.details.created).toBe(true);
  });

  it("built-in types still work alongside custom types", async () => {
    writeSettings({ decision: "decisions" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "entity", title: "Test Entity" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "entities", "test-entity.md");
    expect(existsSync(expected)).toBe(true);
  });

  it("custom type uses generic template when no content provided", async () => {
    writeSettings({ metric: "metrics" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "metric", title: "API Latency" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "metrics", "api-latency.md");
    const body = readFileSync(file, "utf-8");
    expect(body).toContain("# API Latency");
    expect(body).toContain("## Links");
  });

  it("custom type with explicit content writes that content", async () => {
    writeSettings({ decision: "decisions" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "decision", title: "Use Postgres", content: "# Use Postgres\n\nWe chose Postgres." },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "decisions", "use-postgres.md");
    const body = readFileSync(file, "utf-8");
    expect(body).toContain("We chose Postgres.");
  });

  it("undefined customTypes (no config) falls back to built-ins only", async () => {
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Test Concept" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "concepts", "test-concept.md");
    expect(existsSync(expected)).toBe(true);
  });

  it("unrecognized type without config falls back to concepts folder", async () => {
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "nonexistent", title: "Fallback Page" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    // folderMap[type] || "concepts" fallback
    const expected = join(getVaultPaths(wikiDir).wiki, "concepts", "fallback-page.md");
    expect(existsSync(expected)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `pnpm vitest run test/custom-types.test.ts`
Expected: All 6 tests pass

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (no regression)

- [ ] **Step 4: Commit**

```bash
git add test/custom-types.test.ts
git commit -m "test: custom wiki page types via config"
```

---

## Task 4: Final verification

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Full test suite one more time**

Run: `pnpm test`
Expected: All tests green

- [ ] **Step 4: If all green, push branch and open PR**

```bash
git push -u origin feat/custom-wiki-page-types
gh pr create --title "feat: support custom wiki page types via config (closes #169)" --body "..."
```
