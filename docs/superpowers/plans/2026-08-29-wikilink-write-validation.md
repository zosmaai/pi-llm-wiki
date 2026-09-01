# Wikilink Pre-Write Validation & Normalization (Layer 2, issue #172) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the deterministic ingest write path (`commitSynthesis`) so wikilinks in an ingested source body are validated/normalized before pages are written, per a new `wikilinkValidation` setting (default `warn`).

**Architecture:** A pure helper `auditWikilinks(body, index, sourceId, mode)` reuses the existing `extractKnowledgeLinks` + `resolveWikilink` from Layer 1. It returns diagnostics (`link_unresolved`/`link_ambiguous`) and, in `normalize` mode, a rewritten body where resolvable targets are replaced by their canonical page id. `commitSynthesis` — the single choke point for background ingest writes — builds an index from the existing registry **plus the pages this commit creates** (so same-batch links don't false-positive), runs the gate on the source body, and per mode: `off` (no-op), `warn` (collect diagnostics, write proceeds), `strict` (block the write, return `ok:false`), `normalize` (rewrite the body, then write). The mode is threaded from `runtime.config` through `runIngestSynthesis` into `commitSynthesis`, exactly mirroring the existing `synthesisLanguage` plumbing.

**Tech Stack:** TypeScript (ESM, ES2022), Vitest, `node:fs`, existing `knowledge-links.ts` resolver (Layer 1).

**Roadmap:** None

**Phase:** Single-plan implementation

---

## Scope (decided with user)

- **Default mode: `warn`.** Ingest always writes; broken links are reported, not blocked, unless the user opts into `strict`.
- **Write path: ingest only.** `commitSynthesis` is the deterministic background-ingest writer (the default `wiki_ingest` path). The other write paths (retro/observe/lint-stub, and the `background:false` manual path where the main agent writes directly) are **out of scope** — follow-up.
- **Body gated: the ingested SOURCE body only.** Entity/concept pages are generated one-line templates whose only wikilink is the self-reference `[[sources/<id>]]` (always resolves). The model-authored links all live in the source body (`summary`, `key_takeaways`, `quotes`). Auditing only the source body is the lazy-correct scope; description-field auditing is a follow-up if needed.
- **Normalization is alias-safe:** it rewrites only the link *target* token (via the same regex the parser uses), preserving any `|alias`, so no structural link is ever corrupted.

## File Structure

- **Modify** `extensions/llm-wiki/lib/task-config.ts` — add `WikilinkValidationMode` usage to the `TaskConfig` interface, a `resolveWikilinkValidation()` resolver, and the `KNOWN_KEYS` entry.
- **Modify** `extensions/llm-wiki/lib/knowledge-links.ts` — export `auditWikilinks()` + `WikilinkAuditResult` (the `WikilinkValidationMode` type was already added in Task 1).
- **Modify** `extensions/llm-wiki/lib/ingest-worker.ts` — add `wikilinkValidation?` param to `commitSynthesis`, `wikilinkDiagnostics?` to `CommitResult`, and `wikilinkValidation?` to `RunIngestSynthesisArgs`; wire the gate into `commitSynthesis` and thread the mode through `runIngestSynthesis`.
- **Modify** `extensions/llm-wiki/lib/tools.ts` — pass `runtime.config.wikilinkValidation` into `runIngestSynthesis` and surface diagnostic counts in the ingest report line.
- **Test** `test/knowledge-links.test.ts` (append — `auditWikilinks` unit tests).
- **Test** `test/ingest-worker.test.ts` (append — `commitSynthesis` gate integration tests).
- **Test** `test/task-config.test.ts` (create — `resolveWikilinkValidation` unit tests).

---

### Task 1: Config type + resolver

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts` (add the `WikilinkValidationMode` type only)
- Modify: `extensions/llm-wiki/lib/task-config.ts`
- Test: `test/task-config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/task-config.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  loadTaskConfig,
  resolveWikilinkValidation,
  type TaskConfig,
} from "../extensions/llm-wiki/lib/task-config.js";

describe("resolveWikilinkValidation", () => {
  it("defaults to warn when unset/undefined", () => {
    expect(resolveWikilinkValidation(undefined)).toBe("warn");
    expect(resolveWikilinkValidation({})).toBe("warn");
  });

  it("returns an explicit valid mode", () => {
    for (const m of ["off", "warn", "strict", "normalize"] as const) {
      const config: TaskConfig = { wikilinkValidation: m };
      expect(resolveWikilinkValidation(config)).toBe(m);
    }
  });

  it("falls back to warn on an invalid value", () => {
    const config = { wikilinkValidation: "bogus" } as unknown as TaskConfig;
    expect(resolveWikilinkValidation(config)).toBe("warn");
  });

  it("reads wikilinkValidation from the llm-wiki settings namespace", () => {
    const project = mkdtempSync(join(tmpdir(), "wl-"));
    try {
      mkdirSync(join(project, ".omp"), { recursive: true });
      writeFileSync(
        join(project, ".omp", "settings.json"),
        JSON.stringify({ "llm-wiki": { wikilinkValidation: "strict" } }),
      );
      // The settings value must flow through readNamespacedConfig into TaskConfig.
      expect(resolveWikilinkValidation(loadTaskConfig(project))).toBe("strict");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
```

> The `.omp/settings.json` write pattern mirrors `test/ambient-gate.test.ts` (the host the test suite detects). If the test env detects a different host, write to that host's settings path instead — the assertion on `loadTaskConfig(project)` is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/task-config.test.ts`
Expected: FAIL — `resolveWikilinkValidation` is not exported from `task-config.js`.

- [ ] **Step 3: Write minimal implementation**

**Prep — the mode type lives in `knowledge-links.ts`** (owned here so `task-config.ts` can import it before Task 2's helper exists). Append to `extensions/llm-wiki/lib/knowledge-links.ts`:

```ts
export type WikilinkValidationMode = "off" | "warn" | "strict" | "normalize";
```

Then in `extensions/llm-wiki/lib/task-config.ts`:

(a) Add the import at the top (with the other `./` imports):

```ts
import type { WikilinkValidationMode } from "./knowledge-links.js";
```

(b) Add this field to the `TaskConfig` interface (place it right after the `synthesisMaxTokens?: number;` field, before the closing `}`):

```ts
  /**
   * Wikilink gate applied to the ingested source body before pages are
   * written (issue #172, Layer 2). Reuses the Layer 1 resolver.
   *   - "off"       : no-op.
   *   - "warn"      : write proceeds; unresolved/ambiguous links are reported.
   *   - "strict"    : block the write (commit returns ok:false) if any link is unresolvable.
   *   - "normalize" : rewrite resolvable links to their canonical id, then write.
   * Default "warn". See `resolveWikilinkValidation`.
   */
  wikilinkValidation?: WikilinkValidationMode;
```

(c) Add the resolver, next to `noticesEnabled` (after the `noticesEnabled` function):

```ts
const WIKILINK_VALIDATION_MODES: readonly WikilinkValidationMode[] = [
  "off",
  "warn",
  "strict",
  "normalize",
];

/**
 * Resolve the wikilink write-gate mode (issue #172, Layer 2). Defaults to
 * `warn` — ingest always writes and reports; only an explicit `strict` blocks.
 * Unknown values fall back to `warn` rather than failing the ingest.
 */
export function resolveWikilinkValidation(
  config: TaskConfig | undefined,
): WikilinkValidationMode {
  const v = config?.wikilinkValidation;
  if (v && (WIKILINK_VALIDATION_MODES as readonly string[]).includes(v)) return v;
  return "warn";
}
```

(d) Add `"wikilinkValidation"` to the `KNOWN_KEYS` array (after `"synthesisMaxTokens"`):

```ts
  "wikilinkValidation",
```

(e) Add a parse branch to `readNamespacedConfig` so the value actually reaches `TaskConfig`. This function copies settings keys **explicitly, one branch per key** — the `TaskConfig` field and `KNOWN_KEYS` entry alone do NOT make a settings value flow through. Insert this after the `synthesisMaxTokens` block (after `out.synthesisMaxTokens = Math.floor(maxTokens);`):

```ts
    const wl = section.wikilinkValidation;
    if (
      typeof wl === "string" &&
      (WIKILINK_VALIDATION_MODES as readonly string[]).includes(wl)
    ) {
      out.wikilinkValidation = wl as WikilinkValidationMode;
    }
```

> `wl` narrows to `string` (not the union) via `typeof wl === "string"`; the `.includes` guard already proves it is a valid mode, so the `as WikilinkValidationMode` cast is safe and required for `tsc` (Vitest does not typecheck — this would only fail at `pnpm typecheck` in Task 5 if omitted).

> `WIKILINK_VALIDATION_MODES` is the module-level const defined in step (c) above; the `readNamespacedConfig` body runs at call time, after module evaluation, so declaration order does not matter.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/task-config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/task-config.ts test/task-config.test.ts
git commit -m "feat(wikilink): add wikilinkValidation setting + resolver (default warn)"
```

---

### Task 2: `auditWikilinks` helper

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts`
- Test: `test/knowledge-links.test.ts` (append)

**Context (already in this file):** `buildWikilinkIndex(ids: Iterable<string>)`, `resolveWikilink(target, index): WikilinkResolution` where `WikilinkResolution` is the union `{ kind: "resolved"; id: string } | { kind: "ambiguous"; target: string; candidates: string[] } | { kind: "missing"; target: string }` (note: **`kind`/`id`**, not `status`/`canonicalId`), `extractKnowledgeLinks(body).wikilinks` (array of `{target, offset}`), `normalizeWikilinkTarget(raw)`, the imported `KnowledgeDiagnostic` type, and `WikilinkValidationMode` (added in Task 1). The parser regex is `/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g`.

- [ ] **Step 1: Write the failing test**

Two edits to `test/knowledge-links.test.ts`:

1. Add `auditWikilinks` to the **existing** top-of-file import (the one that already imports `buildResolvedBacklinks`, `buildWikilinkIndex`, `extractKnowledgeLinks`, `extractLegacyWikilinks`). Do NOT add a second import statement from this module.
2. Append this `describe` block to the **end** of the file. `buildWikilinkIndex` is already imported at the top, so it is used directly (no alias, no new import):

```ts
const idx = buildWikilinkIndex([
  "entities/alice",
  "concepts/transformer",
  "concepts/attention",
  "concepts/other-page",
]);

describe("auditWikilinks", () => {
  it("off returns no diagnostics and unchanged body", () => {
    const r = auditWikilinks("see [[ghost]]", idx, "SRC-001", "off");
    expect(r.diagnostics).toEqual([]);
    expect(r.body).toBe("see [[ghost]]");
    expect(r.changed).toBe(false);
  });

  it("warn reports an unresolved link and leaves the body untouched", () => {
    const r = auditWikilinks("bad [[ghost]]", idx, "SRC-001", "warn");
    expect(r.body).toBe("bad [[ghost]]");
    expect(r.diagnostics.map((d) => d.code)).toContain("link_unresolved");
  });

  it("warn flags ambiguous when a bare target matches multiple pages", () => {
    const ambiguous = buildWikilinkIndex(["entities/alice", "concepts/alice"]);
    const r = auditWikilinks("who is [[alice]]?", ambiguous, "SRC-001", "warn");
    const amb = r.diagnostics.find((d) => d.code === "link_ambiguous");
    expect(amb).toBeDefined();
    expect(r.body).toBe("who is [[alice]]?");
  });

  it("normalize rewrites resolvable targets to canonical id, preserves alias", () => {
    const body = "see [[transformer|TF]] and [[alice]]";
    const r = auditWikilinks(body, idx, "SRC-001", "normalize");
    expect(r.body).toBe("see [[concepts/transformer|TF]] and [[entities/alice]]");
    expect(r.changed).toBe(true);
  });

  it("normalize leaves unresolvable links verbatim", () => {
    const r = auditWikilinks("see [[ghost]]", idx, "SRC-001", "normalize");
    expect(r.body).toBe("see [[ghost]]");
    expect(r.changed).toBe(false);
  });

  it("normalize is a no-op when every link is already canonical", () => {
    const r = auditWikilinks("see [[concepts/attention]]", idx, "SRC-001", "normalize");
    expect(r.body).toBe("see [[concepts/attention]]");
    expect(r.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/knowledge-links.test.ts -t auditWikilinks`
Expected: FAIL — `auditWikilinks` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to the end of `extensions/llm-wiki/lib/knowledge-links.ts` (the `WikilinkValidationMode` type was already added in Task 1 — do NOT redefine it):

```ts
// ── Pre-write validation & normalization (issue #172, Layer 2) ─────────

export interface WikilinkAuditResult {
  /** Unresolved / ambiguous link diagnostics (empty for "off" / clean bodies). */
  diagnostics: KnowledgeDiagnostic[];
  /** The body after normalization (identical to input unless normalize rewrote links). */
  body: string;
  /** True only when normalize changed the body. */
  changed: boolean;
}

const WIKILINK_REPLACE_RE = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;

/**
 * Audit a markdown body's wikilinks against the page index.
 *
 * - Collects `link_unresolved` / `link_ambiguous` diagnostics for every link
 *   that does not resolve to exactly one page (skipped for "off").
 * - In "normalize" mode, additionally rewrites each link that DOES resolve to
 *   its canonical page id. Only the target token is replaced (the parser's own
 *   regex is reused), so `|alias`, escaping, and surrounding text are preserved.
 *
 * Pure: no I/O. The caller supplies the index (typically `buildWikilinkIndex`
 * over existing page ids plus the ids created by the same commit).
 */
export function auditWikilinks(
  body: string,
  index: WikilinkIndex,
  sourceId: string,
  mode: WikilinkValidationMode,
): WikilinkAuditResult {
  if (mode === "off") return { diagnostics: [], body, changed: false };

  const diagnostics: KnowledgeDiagnostic[] = [];
  for (const { target } of extractKnowledgeLinks(body).wikilinks) {
    const resolved = resolveWikilink(target, index);
    if (resolved.kind === "ambiguous") {
      diagnostics.push({
        severity: "warning",
        code: "link_ambiguous",
        path: sourceId,
        message: `Wikilink target "${target}" matches multiple pages (${resolved.candidates.join(", ")}).`,
      });
    } else if (resolved.kind === "missing") {
      diagnostics.push({
        severity: "warning",
        code: "link_unresolved",
        path: sourceId,
        message: `Wikilink target "${target}" does not match any page.`,
      });
    }
  }

  let out = body;
  if (mode === "normalize") {
    out = body.replace(WIKILINK_REPLACE_RE, (full, raw: string, alias: string | undefined) => {
      const resolved = resolveWikilink(normalizeWikilinkTarget(raw), index);
      return resolved.kind === "resolved"
        ? `[[${resolved.id}${alias ?? ""}]]`
        : full;
    });
  }

  return { diagnostics, body: out, changed: out !== body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/knowledge-links.test.ts`
Expected: PASS (existing + new `auditWikilinks` tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/knowledge-links.ts test/knowledge-links.test.ts
git commit -m "feat(wikilink): add auditWikilinks (warn/strict/normalize, alias-safe)"
```

---

### Task 3: Wire the gate into `commitSynthesis`

**Files:**
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts`
- Test: `test/ingest-worker.test.ts` (append)

**Context (already imported in this file):** `join`, `existsSync`, `readKnowledgeDocumentFile`, `writeKnowledgeDocumentFile`, `createKnowledgeDocument`, `patchKnowledgeDocument`, `buildIngestedSourcePageBody` (local), `slugify`, `VaultPaths`. The existing test file uses `getVaultPaths(wikiDir)` + `ensureVaultStructure(paths)` to build a vault and calls `commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06")`.

- [ ] **Step 1: Write the failing test**

Append to `test/ingest-worker.test.ts`. Reuse the file's existing `MANIFEST`, and its `beforeEach`/`afterEach` vault scaffolding (`wikiDir`, `getVaultPaths`, `ensureVaultStructure`). Follow the exact variable names those hooks already declare.

```ts
import { auditWikilinks } from "../extensions/llm-wiki/lib/knowledge-links.js";

describe("commitSynthesis wikilink gate", () => {
  function makeData(summary: string): SynthesisData {
    return {
      summary,
      key_takeaways: ["a"],
      entities: [{ title: "Alice", description: "A person." }],
      concepts: [{ title: "Transformer", definition: "An architecture." }],
    };
  }

  it("strict blocks the write and returns ok:false on an unresolved link", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(
      paths,
      "SRC-001",
      MANIFEST,
      makeData("See [[ghost-page]] for details."),
      "2026-06-06",
      undefined,
      "strict",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.diagnostics.map((d) => d.code)).toContain("link_unresolved");
    }
    // Nothing was written:
    expect(existsSync(join(paths.wiki, "sources", "SRC-001.md"))).toBe(false);
    expect(existsSync(join(paths.wiki, "entities", "alice.md"))).toBe(false);
  });

  it("warn writes and attaches wikilinkDiagnostics", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(
      paths,
      "SRC-001",
      MANIFEST,
      makeData("See [[ghost-page]] for details."),
      "2026-06-06",
      undefined,
      "warn",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.wikilinkDiagnostics?.map((d) => d.code)).toContain("link_unresolved");
    }
    expect(existsSync(join(paths.wiki, "sources", "SRC-001.md"))).toBe(true);
  });

  it("normalize rewrites resolvable links to canonical ids in the written page", () => {
    const paths = getVaultPaths(wikiDir);
    // [[transformer]] resolves because makeData() creates a "Transformer" concept
    // in the SAME commit — buildIngestAuditIndex adds concepts/transformer to the
    // index, so no pre-existing page is needed (this also proves same-batch links resolve).
    const res = commitSynthesis(
      paths,
      "SRC-001",
      MANIFEST,
      makeData("The [[transformer|T]] changed everything."),
      "2026-06-06",
      undefined,
      "normalize",
    );
    expect(res.ok).toBe(true);
    const written = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf-8");
    expect(written).toContain("[[concepts/transformer|T]]");
  });

  it("off is a no-op (writes verbatim, no diagnostics)", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(
      paths,
      "SRC-001",
      MANIFEST,
      makeData("See [[ghost-page]] for details."),
      "2026-06-06",
      undefined,
      "off",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.wikilinkDiagnostics).toBeUndefined();
    const written = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf-8");
    expect(written).toContain("[[ghost-page]]");
  });

  it("defaults to warn when mode is omitted", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(
      paths,
      "SRC-001",
      MANIFEST,
      makeData("See [[ghost-page]] for details."),
      "2026-06-06",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.wikilinkDiagnostics?.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/ingest-worker.test.ts -t "wikilink gate"`
Expected: FAIL — `commitSynthesis` has no 7th param / `CommitResult` has no `wikilinkDiagnostics`.

- [ ] **Step 3: Write minimal implementation**

In `extensions/llm-wiki/lib/ingest-worker.ts`:

(a) Extend the imports. Add `readJson` to the existing `./utils.js` import line, and add a new import line for the gate:

```ts
import { VaultPaths, fmtDate, slugify, readJson } from "./utils.js";
import { auditWikilinks, buildWikilinkIndex } from "./knowledge-links.js";
import { resolveWikilinkValidation, type WikilinkValidationMode } from "./task-config.js";
```

> If `readJson` is already imported from `./utils.js` on that line, just add it to the existing import list rather than duplicating the line.

(b) Add `wikilinkDiagnostics?` to the `CommitResult` interface (after `contradictions: number;`):

```ts
  /** Wikilink gate diagnostics from `commitSynthesis` (warn/normalize modes). */
  wikilinkDiagnostics?: KnowledgeDiagnostic[];
```

(`KnowledgeDiagnostic` is already imported from `./knowledge-document.js` in this file.)

(c) Add a small local helper just above `commitSynthesis`:

```ts
/**
 * Build the wikilink index used by the pre-write gate: every existing page id
 * (from the registry) plus the page ids this commit is about to create, so a
 * link to a sibling created in the same ingest resolves instead of
 * false-positiving as missing.
 */
function buildIngestAuditIndex(
  paths: VaultPaths,
  sourceId: string,
  data: SynthesisData,
): ReturnType<typeof buildWikilinkIndex> {
  const registry = readJson<{ pages: Record<string, unknown> }>(
    join(paths.meta, "registry.json"),
    { pages: {} },
  );
  const newIds = [
    `sources/${sourceId}`,
    ...data.entities
      .filter((e) => slugify(e.title))
      .map((e) => `entities/${slugify(e.title)}`),
    ...data.concepts
      .filter((c) => slugify(c.title))
      .map((c) => `concepts/${slugify(c.title)}`),
  ];
  return buildWikilinkIndex([...Object.keys(registry.pages), ...newIds]);
}
```

(d) Change the `commitSynthesis` signature — add the trailing `wikilinkValidation?` param:

```ts
export function commitSynthesis(
  paths: VaultPaths,
  sourceId: string,
  manifest: Record<string, unknown>,
  data: SynthesisData,
  date: string = fmtDate(),
  lang?: string,
  wikilinkValidation?: WikilinkValidationMode,
): CommitSynthesisOutcome {
```

(e) In the body, after the `assertWritableVault` try/catch block and before the `// Patch existing documents...` comment, compute the gated source body:

```ts
  // Pre-write wikilink gate (issue #172, Layer 2). Applies only to the
  // model-authored source body; entity/concept pages are generated templates.
  const mode = resolveWikilinkValidation({ wikilinkValidation });
  let sourceBody = buildIngestedSourcePageBody(manifest, data, date, lang);
  if (mode !== "off") {
    const audit = auditWikilinks(sourceBody, buildIngestAuditIndex(paths, sourceId, data), sourceId, mode);
    if (mode === "strict" && audit.diagnostics.length > 0) {
      return { ok: false, sourceId, diagnostics: audit.diagnostics };
    }
    if (mode === "normalize") sourceBody = audit.body;
    if (audit.diagnostics.length > 0) result.wikilinkDiagnostics = audit.diagnostics;
  }
```

(f) Replace both inline `buildIngestedSourcePageBody(manifest, data, date, lang)` calls in the source-document branch with `sourceBody`:

```ts
    sourceDocument = patchKnowledgeDocument(parsed.document, {
      fields: { status: "ingested", updated: date },
      body: sourceBody,
    });
```

and

```ts
      sourceBody,
```

(as the third argument to `createKnowledgeDocument` in the `else` branch).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/ingest-worker.test.ts`
Expected: PASS (existing `commitSynthesis` tests unchanged — they omit the 7th param and thus run in `warn` default, which still writes and is compatible with prior assertions; new gate tests pass).

> If an existing assertion breaks because a pre-existing test fixture now produces wikilink diagnostics that changed a count it asserts on, do NOT weaken the new gate — inspect the fixture. The only expected change is the new optional `wikilinkDiagnostics` field; existing asserted fields are untouched.

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/ingest-worker.ts test/ingest-worker.test.ts
git commit -m "feat(wikilink): gate commitSynthesis writes by wikilinkValidation mode"
```

---

### Task 4: Thread the mode through `runIngestSynthesis` + the tool report

**Files:**
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`

- [ ] **Step 1: Add the arg to `RunIngestSynthesisArgs`**

In `ingest-worker.ts`, add to the `RunIngestSynthesisArgs` interface (after `synthesisMaxTokens?: number;`):

```ts
  /** Wikilink write-gate mode for the ingested source body (issue #172). */
  wikilinkValidation?: WikilinkValidationMode;
```

- [ ] **Step 2: Thread it into `commitSynthesis`**

In `runIngestSynthesis`, add `wikilinkValidation` to the `const { ... } = args;` destructuring block, and pass it as the 7th argument in the `commitSynthesis(...)` call inside `commitTool.execute`:

```ts
      const outcome = commitSynthesis(
        paths,
        sourceId,
        manifest,
        params,
        undefined,
        synthesisLanguage,
        wikilinkValidation,
      );
```

- [ ] **Step 3: Pass the configured mode from the tool**

In `tools.ts`, in the `runtime.launchTask(...)` callback where `runIngestSynthesis({...})` is called, add the arg alongside the existing `synthesisLanguage`:

```ts
                synthesisLanguage: runtime.config.synthesisLanguage,
                wikilinkValidation: runtime.config.wikilinkValidation,
```

- [ ] **Step 4: Surface diagnostics in the report line**

In `tools.ts`, in the same `launchTask` callback, update the summary so warn/normalize diagnostics are visible. Replace the `const summary = committed ? ... : ...` block with:

```ts
              const wl = committed?.wikilinkDiagnostics?.length ?? 0;
              const wlNote = wl > 0 ? `, ${wl} wikilink issue${wl === 1 ? "" : "s"}` : "";
              const summary = committed
                ? `LLM Wiki: ingested ${s.id} → ${committed.entitiesCreated.length} entit${committed.entitiesCreated.length === 1 ? "y" : "ies"}, ${committed.conceptsCreated.length} concept${committed.conceptsCreated.length === 1 ? "" : "s"}${wlNote}`
                : `LLM Wiki: ${s.id} produced no synthesis`;
```

- [ ] **Step 5: Verify types + run affected tests**

Run: `pnpm typecheck && pnpm vitest run test/ingest-worker.test.ts test/ingest-tool.test.ts`
Expected: typecheck clean; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/ingest-worker.ts extensions/llm-wiki/lib/tools.ts
git commit -m "feat(wikilink): thread wikilinkValidation through runIngestSynthesis + report"
```

---

### Task 5: Full gates + deploy note

**Files:** none (verification)

- [ ] **Step 1: Run the full suite + lint + typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 2: Verify `build:commands` parity is unaffected**

Run: `pnpm build:commands && pnpm test`
Expected: no new prompt/parite failures (no `prompts/` files touched).

- [ ] **Step 3: Commit (if any test fixtures adjusted in Step 4 of Task 3)**

```bash
git add -A && git commit -m "test(wikilink): green full suite"
```

> **Deploy note (not a code step):** pi loads this extension from the source path (`../../code/pi-packages/pi-llm-wiki` in `~/.pi/agent/settings.json`). After merging, a **full pi restart** makes it live (a `/reload` does not swap the extension). Verify by ingesting a source whose summary contains a known-broken link and reading the **ingest report line** (`runtime.report(...)`) — it should now append `N wikilink issue(s)` (the Task 4 feature). Do NOT verify via `/wiki-lint`: lint already surfaced broken links before this change and will not behave differently. To enable blocking, set `"wikilinkValidation": "strict"` (or `"normalize"`) under the `llm-wiki` key in settings.

---

## Self-Review

**Spec/roadmap coverage:**
- #172 "pre-write wikilink validation and normalization" → Task 2 (helper) + Task 3 (gate at write) + Task 1 (config) + Task 4 (wiring/report). ✅
- Modes `off|warn|strict|normalize` → Task 1 resolver + Task 2 helper + Task 3 gate. ✅
- Default `warn` (user decision) → Task 1 resolver. ✅
- **Settings → config flow** (so a user setting actually reaches the gate) → Task 1 Step 3(e) `readNamespacedConfig` branch + the settings-namespace flow test in Task 1 Step 1. ✅
- Ingest-only scope, source-body-only gate (decided) → Task 3 (documented in scope). ✅

**Placeholder scan:** All steps contain exact code, exact commands, and expected output. No "TBD"/"add appropriate handling". ✅

**Type consistency:**
- `WikilinkValidationMode` defined once (Task 1, `knowledge-links.ts`); Task 1 imports it into `task-config.ts`; Task 2 uses it in `auditWikilinks`; Task 3 imports it into `ingest-worker.ts`. One definition, no drift. ✅
- `auditWikilinks(body, index, sourceId, mode): WikilinkAuditResult` signature identical in Task 2 def and Task 3 usage. ✅
- `commitSynthesis` 7th param `wikilinkValidation?: WikilinkValidationMode` consistent across def (Task 3) and `runIngestSynthesis` call (Task 4). ✅
- `CommitResult.wikilinkDiagnostics?: KnowledgeDiagnostic[]` consistent across Task 3 (def + set) and Task 4 (report read `committed?.wikilinkDiagnostics?.length`). ✅
- `resolveWikilinkValidation(config?)` Task 1 def; Task 3 calls `resolveWikilinkValidation({ wikilinkValidation })` — valid (accepts `TaskConfig | undefined`). ✅
- `resolveWikilink` API: Task 2 uses the real `kind`/`id` union (NOT `status`/`canonicalId`) — matches `knowledge-links.ts` `WikilinkResolution`. ✅
- `readNamespacedConfig` branch (Task 1 Step 3e) uses the same `WIKILINK_VALIDATION_MODES` const and sets `out.wikilinkValidation`, matching the `TaskConfig` field. ✅

**Phase boundary health:** Single plan; after Task 5 the feature is complete, default `warn` is non-destructive (writes always proceed, only reports), and all gates are green. No half-migrations: the new config field is optional with a default; the new `commitSynthesis` param is optional; `CommitResult.wikilinkDiagnostics` is optional. Existing callers omitting the new params keep prior behavior (default `warn`, which still writes). ✅
