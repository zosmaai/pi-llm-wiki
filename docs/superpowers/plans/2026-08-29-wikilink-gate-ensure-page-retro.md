# Wikilink Gate on `wiki_ensure_page` / `wiki_retro` (#172 re-target) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the pre-write wikilink gate to the two direct-content tools `wiki_ensure_page` and `wiki_retro` — the path issue #172 actually names — reusing the already-built `auditWikilinks` resolver and the `wikilinkValidation` setting (modes `off|warn|strict|normalize`, default `warn`).

**Architecture:** A new small pure helper `applyWikilinkGate(body, index, sourceId, mode)` in `knowledge-links.ts` wraps `auditWikilinks` and returns `{ ok, body, diagnostics }`: `ok:false` only when `mode === "strict"` and there are unresolvable/ambiguous links; `body` is the normalized form when `mode === "normalize"`. Each tool's `execute` builds the index from `meta/registry.json` keys (same source the ingest gate uses), runs the gate on the caller-supplied body, and per result: strict → return `isError` (no write); normalize → write the normalized body; warn → write and append a note to the return. The mode is read via `resolveWikilinkValidation(loadTaskConfig(cwd))`.

**Composition with Layer 1 (important):** a wikilink that *resolves* (even if bare-title/case-drifted) is never flagged — it is only rewritten in `normalize` mode. Only genuinely **missing** or **ambiguous** targets produce diagnostics. So `strict` blocks only on real gaps, not on cosmetic drift.

**Tech Stack:** TypeScript (ESM), Vitest, existing `auditWikilinks` / `buildWikilinkIndex` / `resolveWikilink` / `readJson` / `loadTaskConfig`.

**Roadmap:** None

**Phase:** Single-plan follow-up to #172 (Layer 2a — ingest gate — is already merged and stays).

---

## Scope (decided with user)

- **Keep all four modes**, default **`warn`** (non-mutating, non-blocking, surfaces issues — safe + useful).
- **Keep the existing ingest gate** (already merged, tested, non-destructive) — this plan adds the direct-tool gate on top.
- **New write paths gated:** `wiki_ensure_page` (tools.ts) and `wiki_retro` (retro.ts). These are where a human/agent supplies `content`/`body` verbatim — the issue's exact target.
- **Two-axis doc comment** added to `WikilinkValidationMode` so the modes aren't misread as a severity ladder.
- **MCP path out of scope:** `retroOperation` (mcp/operations.ts) is not gated here; the gate sits at the Pi tool boundary (where the issue's agent caller lives). MCP coverage is a follow-up.

## File Structure

- **Modify** `extensions/llm-wiki/lib/knowledge-links.ts` — add `applyWikilinkGate()` + `WikilinkGateResult`; add the two-axis doc comment to `WikilinkValidationMode`.
- **Modify** `extensions/llm-wiki/lib/tools.ts` — gate `wiki_ensure_page` in `registerWikiEnsurePage`.
- **Modify** `extensions/llm-wiki/lib/retro.ts` — gate `wiki_retro` in `registerWikiRetro`.
- **Test** `test/knowledge-links.test.ts` (append — `applyWikilinkGate` unit tests).
- **Test** `test/wikilink-gate.test.ts` (create — `wiki_ensure_page` + `wiki_retro` gate integration tests).

---

### Task 1: `applyWikilinkGate` helper + two-axis doc

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts`
- Test: `test/knowledge-links.test.ts` (append)

**Context (already in this file):** `auditWikilinks(body, index, sourceId, mode): { diagnostics, body, changed }`, `WikilinkIndex`, `buildWikilinkIndex(ids)`, `KnowledgeDiagnostic`, and `WikilinkValidationMode` (`"off" | "warn" | "strict" | "normalize"`).

- [ ] **Step 1: Write the failing test**

Append to `test/knowledge-links.test.ts`:

```ts
import { applyWikilinkGate } from "../extensions/llm-wiki/lib/knowledge-links.js";

const gateIdx = buildWikilinkIndex(["concepts/transformer"]);

describe("applyWikilinkGate", () => {
  const body = "see [[transformer]] and [[ghost]]";

  it("off → ok, unchanged body, no diagnostics", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "off");
    expect(r.ok).toBe(true);
    expect(r.body).toBe(body);
    expect(r.diagnostics).toEqual([]);
  });

  it("warn → ok, unchanged body, reports only the missing link", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "warn");
    expect(r.ok).toBe(true);
    expect(r.body).toBe(body); // not rewritten
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(["link_unresolved"]); // [[ghost]] only; [[transformer]] resolves
  });

  it("strict → not ok when a link is missing", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "strict");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBe(1);
  });

  it("strict → ok when every link resolves", () => {
    const r = applyWikilinkGate("see [[transformer]]", gateIdx, "x", "strict");
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it("normalize → rewrites resolvable links, still reports missing", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "normalize");
    expect(r.ok).toBe(true);
    expect(r.body).toBe("see [[concepts/transformer]] and [[ghost]]");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link_unresolved"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/knowledge-links.test.ts -t applyWikilinkGate`
Expected: FAIL — `applyWikilinkGate` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `extensions/llm-wiki/lib/knowledge-links.ts`:

(a) Replace the existing `WikilinkValidationMode` type declaration (the single line `export type WikilinkValidationMode = "off" | "warn" | "strict" | "normalize";` added in Task 1 of the earlier plan) with a documented version:

```ts
/**
 * Pre-write wikilink gate mode (issue #172). Two independent behaviors, not a
 * severity ladder:
 *   1. resolvable-but-drifted links (target exists): leave vs. rewrite-to-canonical
 *   2. unresolvable links (target absent — a forward reference / gap): ignore vs. report vs. reject
 *
 *   off       = leave + ignore   (opt-out; zero behavior change)
 *   warn      = leave + report   (default; non-mutating, non-blocking, surfaces issues)
 *   normalize = rewrite + report (fixes resolvable links; still reports gaps)
 *   strict    = leave + reject   (blocks the write with the bad links named; agent retry signal)
 *
 * A link that RESOLVES is never flagged — only normalized. Only missing/ambiguous targets
 * produce diagnostics.
 */
export type WikilinkValidationMode = "off" | "warn" | "strict" | "normalize";
```

(b) Append this helper at the end of the file (after `auditWikilinks`):

```ts
export interface WikilinkGateResult {
  /** false only when mode === "strict" AND there are unresolvable/ambiguous links. */
  ok: boolean;
  /** The body to write (normalized when mode === "normalize", else the input). */
  body: string;
  /** Unresolved / ambiguous link diagnostics (empty for "off" / clean bodies). */
  diagnostics: KnowledgeDiagnostic[];
}

/**
 * Apply the pre-write wikilink gate to a body. Wraps {@link auditWikilinks}:
 * blocks (ok:false) only in strict mode with issues, rewrites in normalize mode,
 * and always returns the diagnostics so callers can surface them (warn/normalize).
 */
export function applyWikilinkGate(
  body: string,
  index: WikilinkIndex,
  sourceId: string,
  mode: WikilinkValidationMode,
): WikilinkGateResult {
  if (mode === "off") return { ok: true, body, diagnostics: [] };
  const audit = auditWikilinks(body, index, sourceId, mode);
  return {
    ok: !(mode === "strict" && audit.diagnostics.length > 0),
    body: mode === "normalize" ? audit.body : body,
    diagnostics: audit.diagnostics,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/knowledge-links.test.ts`
Expected: PASS (all existing + new `applyWikilinkGate` tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/knowledge-links.ts test/knowledge-links.test.ts
git commit -m "feat(wikilink): add applyWikilinkGate helper + document the two-axis modes"
```

---

### Task 2: Gate `wiki_ensure_page`

**Files:**
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Test: `test/wikilink-gate.test.ts` (create — this task adds the `wiki_ensure_page` describe block; Task 3 adds the `wiki_retro` block to the same file)

**Context:** In `registerWikiEnsurePage`'s `execute`, the current flow computes `const body = params.content ?? buildPageBody(type, params.title);` then `createKnowledgeDocument(..., body)` then `writeKnowledgeDocumentFile`. `paths` (VaultPaths) is in scope; `ctx.cwd` is the vault root. `readJson` and `join` are already imported in tools.ts. The tool returns `{ content: [{ type:"text", text }], details }`.

- [ ] **Step 1: Write the failing test**

Create `test/wikilink-gate.test.ts`:

```ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

function capture(fn: (pi: ExtensionAPI) => void): Tool {
  let tool: Tool | undefined;
  const pi = { registerTool: (def: unknown) => (tool = def as Tool) } as unknown as ExtensionAPI;
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
    `wg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const llm = join(wikiDir, ".llm-wiki");
  for (const d of ["wiki/entities", "wiki/concepts", "wiki/sources", "meta", "outputs"]) {
    mkdirSync(join(llm, d), { recursive: true });
  }
  // config.json is required — both tools call inspectWritableVault, which hard-blocks
  // on an absent/unreadable config (config_invalid_knowledge_format). Mirror retro.test.ts.
  writeFileSync(
    join(llm, "config.json"),
    JSON.stringify({ topic: "Test", mode: "personal" }),
  );
  ensureVaultStructure(getVaultPaths(wikiDir));
  // Seed the registry with one resolvable target so [[transformer]] resolves and [[ghost]] does not.
  writeFileSync(
    join(llm, "meta", "registry.json"),
    JSON.stringify({
      version: "1.0",
      last_updated: "",
      pages: { "concepts/transformer": { id: "concepts/transformer", title: "Transformer", type: "concept" } },
    }),
  );
  // No .pi/settings.json here → default mode is "warn".
});

afterEach(() => {
  try {
    rmSync(wikiDir, { recursive: true, force: true }); // only this test's own root, never the shared test/tmp
  } catch {}
});

function setMode(mode: string): void {
  const cfg = join(wikiDir, ".pi");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ "llm-wiki": { wikilinkValidation: mode } }));
}

describe("wiki_ensure_page wikilink gate", () => {
  const content = "see [[transformer]] and [[ghost]]";

  it("off → writes verbatim, no issues surfaced", async () => {
    setMode("off");
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "concepts", "ghost-concept.md");
    expect(existsSync(file)).toBe(true);
    expect(res.details.wikilinkIssues).toEqual([]);
  });

  it("warn → writes, reports the missing link (transformer resolves, not reported)", async () => {
    const tool = capture((pi) => registerWikiEnsurePage(pi)); // default warn
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const issues = res.details.wikilinkIssues as string[];
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("ghost");
  });

  it("strict → rejects, writes nothing", async () => {
    setMode("strict");
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBe(true);
    expect(res.details.error).toBe("link_validation");
    expect(existsSync(join(getVaultPaths(wikiDir).wiki, "concepts", "ghost-concept.md"))).toBe(false);
  });

  it("normalize → rewrites resolvable link, reports the missing one", async () => {
    setMode("normalize");
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "concepts", "ghost-concept.md");
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("[[concepts/transformer]]");
    expect(text).toContain("[[ghost]]");
  });
});
```

> Note: add `readFileSync` to the `node:fs` import at the top (it is used in the `normalize` test).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/wikilink-gate.test.ts`
Expected: FAIL — the `wiki_ensure_page` gate is not implemented (`res.details.wikilinkIssues` undefined; strict does not reject; normalize does not rewrite).

- [ ] **Step 3: Write minimal implementation**

In `extensions/llm-wiki/lib/tools.ts`:

(a) Extend imports. Add `loadTaskConfig, resolveWikilinkValidation` to the existing task-config import line (currently `import { parseModelRef } from "./task-config.js";`):

```ts
import { parseModelRef, loadTaskConfig, resolveWikilinkValidation } from "./task-config.js";
```

Add a new import line (near the other `./` imports):

```ts
import { applyWikilinkGate, buildWikilinkIndex } from "./knowledge-links.js";
```

> `readJson` and `join` are already imported in tools.ts — do not re-import them.

(b) In `registerWikiEnsurePage`'s `execute`, change `const body = params.content ?? buildPageBody(type, params.title);` to `let body = ...` and insert the gate immediately after it (before `const doc = createKnowledgeDocument(...)`):

```ts
      let body = params.content ?? buildPageBody(type, params.title);

      // Pre-write wikilink gate (#172): validate/normalize caller-supplied content.
      const mode = resolveWikilinkValidation(loadTaskConfig(ctx.cwd));
      let wikilinkIssues: string[] = [];
      if (mode !== "off") {
        const registry = readJson<{ pages: Record<string, unknown> }>(
          join(paths.meta, "registry.json"),
          { pages: {} },
        );
        const gate = applyWikilinkGate(
          body,
          buildWikilinkIndex(Object.keys(registry.pages)),
          `${folder}/${slug}`,
          mode,
        );
        wikilinkIssues = gate.diagnostics.map((d) => d.message);
        if (!gate.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Rejected write — unresolved/ambiguous wikilinks:\n${wikilinkIssues
                  .map((m) => `- ${m}`)
                  .join("\n")}`,
              },
            ],
            details: { error: "link_validation", issues: wikilinkIssues } as Record<string, unknown>,
            isError: true,
          };
        }
        if (mode === "normalize") body = gate.body;
      }
```

(c) In the success `return` of `registerWikiEnsurePage`, append the note and the `wikilinkIssues` detail. Replace:

```ts
      return {
        content: [{ type: "text", text: `✅ Created ${type} page: \`${pagePath}\`` }],
        details: { path: pagePath, created: true } as Record<string, unknown>,
      };
```

with:

```ts
      const gateNote = wikilinkIssues.length
        ? `\n\n⚠️ ${wikilinkIssues.length} wikilink issue(s):\n${wikilinkIssues.map((m) => `- ${m}`).join("\n")}`
        : "";
      return {
        content: [
          { type: "text", text: `✅ Created ${type} page: \`${pagePath}\`${gateNote}` },
        ],
        details: {
          path: pagePath,
          created: true,
          wikilinkIssues,
        } as Record<string, unknown>,
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/wikilink-gate.test.ts`
Expected: PASS (4 `wiki_ensure_page` tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/tools.ts test/wikilink-gate.test.ts
git commit -m "feat(wikilink): gate wiki_ensure_page writes by wikilinkValidation mode"
```

---

### Task 3: Gate `wiki_retro`

**Files:**
- Modify: `extensions/llm-wiki/lib/retro.ts`
- Test: `test/wikilink-gate.test.ts` (append the `wiki_retro` describe block)

**Context:** In `registerWikiRetro`'s `execute`, the flow resolves `paths = resolveVaultPaths(ctx.cwd ?? process.cwd())`, then `result = saveInsight(paths, params.slug, params.title, params.body, params.category, { rebuild: !runtime })`, then returns a multi-line success message. `params.body` is the caller-supplied markdown (the gate target). The success `details` currently is `{ slug, title, category }`.

- [ ] **Step 1: Write the failing test**

Append to `test/wikilink-gate.test.ts`. Add `registerWikiRetro` to the imports and `readFileSync` is already imported. Append this block at the end of the file (it reuses the same `beforeEach` vault + `setMode` + `capture` helpers):

```ts
import { registerWikiRetro } from "../extensions/llm-wiki/lib/retro.js";

describe("wiki_retro wikilink gate", () => {
  const body = "Learned about [[transformer]] and [[ghost]]";

  it("warn (default) → saves, reports the missing link", async () => {
    const tool = capture((pi) => registerWikiRetro(pi));
    const res = await tool.execute(
      "t",
      { slug: "transformer-note", title: "Transformer Note", body },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const issues = res.details.wikilinkIssues as string[];
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("ghost");
    expect(existsSync(join(getVaultPaths(wikiDir).wiki, "sources", "transformer-note.md"))).toBe(true);
  });

  it("strict → rejects, writes nothing", async () => {
    setMode("strict");
    const tool = capture((pi) => registerWikiRetro(pi));
    const res = await tool.execute(
      "t",
      { slug: "transformer-note", title: "Transformer Note", body },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBe(true);
    expect(res.details.error).toBe("link_validation");
    expect(existsSync(join(getVaultPaths(wikiDir).wiki, "sources", "transformer-note.md"))).toBe(false);
  });

  it("normalize → saves with the resolvable link rewritten", async () => {
    setMode("normalize");
    const tool = capture((pi) => registerWikiRetro(pi));
    const res = await tool.execute(
      "t",
      { slug: "transformer-note", title: "Transformer Note", body },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const text = readFileSync(join(getVaultPaths(wikiDir).wiki, "sources", "transformer-note.md"), "utf-8");
    expect(text).toContain("[[concepts/transformer]]");
    expect(text).toContain("[[ghost]]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/wikilink-gate.test.ts -t "wiki_retro wikilink gate"`
Expected: FAIL — the `wiki_retro` gate is not implemented.

- [ ] **Step 3: Write minimal implementation**

In `extensions/llm-wiki/lib/retro.ts`:

(a) Imports. Make these exact changes (retro.ts currently has `import { dirname, resolve } from "node:path";` on line 1 and `import { type VaultPaths, fmtDate, resolveVaultPaths } from "./utils.js";` on line 8):
- Line 1: `import { dirname, resolve } from "node:path";` → `import { dirname, join, resolve } from "node:path";` (add `join`).
- Line 8: add `readJson` → `import { type VaultPaths, fmtDate, readJson, resolveVaultPaths } from "./utils.js";`
- Add two new import lines near the other `./` imports:

```ts
import { applyWikilinkGate, buildWikilinkIndex } from "./knowledge-links.js";
import { loadTaskConfig, resolveWikilinkValidation } from "./task-config.js";
```

No `node:fs` import is needed — the gate only uses `readJson` (from utils) and `join` (from node:path).

(b) In `registerWikiRetro`'s `execute`, insert the gate BEFORE the `try { result = saveInsight(...); }` block, and thread the (possibly normalized) body into `saveInsight`. Insert before the `let result: RetroResult;` line:

```ts
      // Pre-write wikilink gate (#172): validate/normalize caller-supplied body.
      const mode = resolveWikilinkValidation(loadTaskConfig(ctx.cwd ?? process.cwd()));
      let body = params.body;
      let wikilinkIssues: string[] = [];
      if (mode !== "off") {
        const registry = readJson<{ pages: Record<string, unknown> }>(
          join(paths.meta, "registry.json"),
          { pages: {} },
        );
        const gate = applyWikilinkGate(
          body,
          buildWikilinkIndex(Object.keys(registry.pages)),
          `sources/${params.slug}`,
          mode,
        );
        wikilinkIssues = gate.diagnostics.map((d) => d.message);
        if (!gate.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Rejected write — unresolved/ambiguous wikilinks:\n${wikilinkIssues
                  .map((m) => `- ${m}`)
                  .join("\n")}`,
              },
            ],
            details: { error: "link_validation", issues: wikilinkIssues } as Record<string, unknown>,
            isError: true,
          };
        }
        if (mode === "normalize") body = gate.body;
      }
```

Then change the `saveInsight` call to use `body` instead of `params.body`:

```ts
        result = saveInsight(paths, params.slug, params.title, body, params.category, {
          rebuild: !runtime,
        });
```

(c) In the success `return`, append the note and `wikilinkIssues`. Replace the text array join and details:

```ts
      const gateNote = wikilinkIssues.length
        ? `\n\n⚠️ ${wikilinkIssues.length} wikilink issue(s):\n${wikilinkIssues.map((m) => `- ${m}`).join("\n")}`
        : "";
      return {
        content: [
          {
            type: "text",
            text: [
              `🧠 **Insight saved**: ${params.title}`,
              "",
              `- Page: \`${result.sourcePagePath}\``,
              "",
              "This insight will be auto-surfaced by wiki_recall in future sessions.",
              gateNote,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: {
          slug: params.slug,
          title: params.title,
          category: params.category || null,
          wikilinkIssues,
        } as Record<string, unknown>,
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/wikilink-gate.test.ts`
Expected: PASS (all `wiki_ensure_page` + `wiki_retro` gate tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/retro.ts test/wikilink-gate.test.ts
git commit -m "feat(wikilink): gate wiki_retro writes by wikilinkValidation mode"
```

---

### Task 4: Full gates

**Files:** none (verification)

- [ ] **Step 1: Full suite + lint + typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. Watch that pre-existing `wiki_retro`/`wiki_ensure_page` tests still pass (they omit a mode → default `warn`, which still writes and only adds an empty `wikilinkIssues` detail).

- [ ] **Step 2: Format + build:commands parity**

Run: `npx @biomejs/biome check --write extensions/llm-wiki/lib/knowledge-links.ts extensions/llm-wiki/lib/tools.ts extensions/llm-wiki/lib/retro.ts test/wikilink-gate.test.ts test/knowledge-links.test.ts && pnpm build:commands && pnpm test`
Expected: clean; re-run tests after the format pass.

- [ ] **Step 3: Commit if the format pass changed anything**

```bash
git add -A && git commit -m "style(wikilink): biome format on ensure_page/retro gate files"
```

> **Deploy note (not a code step):** pi loads this from the source path. After merging, a **full pi restart** makes it live. Verify by calling `wiki_ensure_page` (or `wiki_retro`) with a body containing a link to a nonexistent page and confirming the return names the issue (default `warn`). To block, set `"wikilinkValidation": "strict"` under the `llm-wiki` key in settings.

---

## Self-Review

**Spec/roadmap coverage:**
- #172 "pre-write link validation for `wiki_ensure_page` / `wiki_retro`" → Task 2 (ensure_page) + Task 3 (retro) + Task 1 (shared helper). ✅
- All four modes, default `warn` → Task 1 helper + Tasks 2–3 wiring (reuses existing `resolveWikilinkValidation` default). ✅
- Two-axis doc comment → Task 1 Step 3(a). ✅
- Composition with Layer 1 (resolvable links normalized, not flagged) → Task 1 tests assert this; encoded in `auditWikilinks` (unchanged). ✅
- Ingest gate preserved (not touched) → out of this plan's edits. ✅

**Placeholder scan:** Every step has exact code, exact commands, expected output. No TBD/TODO. ✅

**Type consistency:**
- `applyWikilinkGate(body, index, sourceId, mode): WikilinkGateResult` defined once (Task 1) and used identically in Tasks 2–3. ✅
- `WikilinkGateResult` = `{ ok, body, diagnostics }` consistent across def and both call sites. ✅
- Reuses existing `auditWikilinks` / `buildWikilinkIndex` / `resolveWikilinkValidation` / `loadTaskConfig` / `readJson` — no redefinition. ✅
- Success-detail field `wikilinkIssues: string[]` consistent between both tools and the tests. ✅

**Phase boundary health:** Single plan; after Task 4 the direct-tool gate is complete, default `warn` is non-destructive (writes always proceed, only reports), all gates green. New behavior is additive: the only new thing on the default path is an (often empty) `wikilinkIssues` detail + an optional report note. Pre-existing tests pass because `warn` never blocks or mutates. MCP `retroOperation` is intentionally out of scope (follow-up). ✅
