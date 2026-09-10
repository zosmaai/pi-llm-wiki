# Wikilink Alias Pipe Escaping — Table-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop escaping `[[target|alias]]` pipes outside of Markdown table rows, so the `.md` files pi writes stay valid for external readers (Obsidian, VS Code Wiki Links) that don't understand the escaped `\|` form.

**Architecture:** The escape logic lives in one pure function `escapeWikilinkAliasPipes(body)` in `extensions/llm-wiki/lib/knowledge-document.ts`, called from both write paths (`createKnowledgeDocument` for new/edited pages and `patchKnowledgeDocument` for ingest source updates). The fix narrows that function so its pipe-escaping regex only runs on lines that are Markdown table rows. Everything else (prose, lists, headings, fenced code) is passed through verbatim. No new files, no new public API — this is a one-function behavioral change.

**Tech Stack:** TypeScript (ES2022, ESM), Vitest (tests), Biome (lint), `tsc` (typecheck). Pure functions, no I/O inside the function under test.

**Roadmap:** None. Single focused bug fix.

**Phase:** Single-plan implementation.

---

## Context (read before starting)

- **The bug:** `escapeWikilinkAliasPipes` applies its escaping regex to *every* non-fenced line, including prose. So `[[entities/peanut-cat|Peanut]]` in a sentence is written to disk as `[[entities/peanut-cat\|Peanut]]`. pi-llm-wiki's own reader tolerates this (`normalizeWikilinkTarget` strips a trailing `\`), but external readers treat `\|` as a literal backslash-pipe and report "Unresolved or ambiguous wiki-link".
- **The intent (introduced in PR #158, commit `7f1eea0`):** the escaping exists so an aliased wikilink inside a Markdown table cell doesn't have its inner `|` read as a cell delimiter. That intent is valid — it just must be *scoped* to table rows.
- **Current code (`knowledge-document.ts` ~line 593):**

  ```ts
  function escapeWikilinkAliasPipes(body: string): string {
    let inFence = false;
    return body
      .split("\n")
      .map((line) => {
        if (/^\s*(`{3,}|~{3,})/.test(line)) {
          inFence = !inFence;
          return line;
        }
        if (inFence) return line;
        return line.replace(/\[\[([^\]\n]*?)(?<!\\)\|([^\]\n]*?)\]\]/g, "[[$1\\|$2]]");
      })
      .join("\n");
  }
  ```

  The final `return line.replace(...)` runs for every non-fenced line — that's the bug.

- **Call sites (both go through `escapeWikilinkAliasPipes`):**
  - `createKnowledgeDocument` → `knowledge-document.ts:634` (`normalizedBody`). Covers `/wiki create_page`, `wiki_ensure_page`, and auto-created stub concepts.
  - `patchKnowledgeDocument` → `knowledge-document.ts:664`. Covers ingest source updates in `ingest-worker.ts:390`.
- **Table-row detection:** a Markdown table row starts (after optional whitespace) with `|` and ends (after optional whitespace) with `|`. Regex: `/^\s*\|.*\|\s*$/`. The separator row (`| --- |`) and header row match this but contain no `[[...|...]]`, so the replace is a no-op on them — safe.
- **Existing test that encodes the buggy behavior and MUST be updated:** `test/ingest-worker.test.ts:309` expects prose `[[concepts/transformer\|T]]`. After the fix it must expect the *unescaped* form `[[concepts/transformer|T]]` (the prose lives in a source page, not a table).
- **Existing tests that must stay green (no change needed):**
  - `test/knowledge-document.test.ts:63` — table row escapes, fenced code does not. Stays.
  - `test/knowledge-links.test.ts:51-52, 61` — reader-side, verifies both escaped and unescaped forms resolve. Unaffected by a writer change. Stays.

## Files changed

- Modify: `extensions/llm-wiki/lib/knowledge-document.ts` (the fix)
- Modify: `test/knowledge-document.test.ts` (add prose regression test)
- Modify: `test/ingest-worker.test.ts` (update buggy escaping assertion)

---

## Task 1: Write a failing test that pins the prose bug

**Files:**
- Modify: `test/knowledge-document.test.ts`

- [ ] **Step 1: Add a regression test asserting prose wikilinks are written verbatim**

Find the existing table-escape test in `test/knowledge-document.test.ts` (around line 63) — it currently ends right before the `it.each([...])` block that starts at line 71:

```ts
  it("escopes alias-pipe escaping to Markdown table rows only", () => {
    const table = createKnowledgeDocument(
      "concepts/table.md",
      { type: "concept" },
      "| Name |\n| --- |\n| [[entities/gildan|Gildan]] |",
    );
    // Table row: alias pipe MUST be escaped so the cell isn't split.
    expect(table.body).toContain("[[entities/gildan\\|Gildan]]");

    const prose = createKnowledgeDocument(
      "concepts/prose.md",
      { type: "concept" },
      "See [[entities/peanut-cat|Peanut]] and [[entities/alice|Alice]] here.",
    );
    // Prose: alias pipes MUST stay literal so external readers follow the link.
    expect(prose.body).toContain("[[entities/peanut-cat|Peanut]]");
    expect(prose.body).toContain("[[entities/alice|Alice]]");
    expect(prose.body).not.toContain("\\|");

    // Fenced code stays verbatim (existing behavior, keep asserting).
    const fenced = createKnowledgeDocument(
      "concepts/fenced.md",
      { type: "concept" },
      "```md\n[[entities/raw|Raw]]\n```",
    );
    expect(fenced.body).toContain("[[entities/raw|Raw]]");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge-document.test.ts -t "escopes alias-pipe escaping to Markdown table rows only"`

Expected: FAIL. The `prose.body` assertions fail because the current implementation escapes the pipes and writes `[[entities/peanut-cat\|Peanut]]`. (The table-row assertion already passes.)

- [ ] **Step 3: Commit the failing test**

```bash
git add test/knowledge-document.test.ts
git commit -m "test: add regression for prose wikilink alias-pipe escaping"
```

Expected: the commit lands with the test still red.

---

## Task 2: Scope the escaping to Markdown table rows only

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-document.ts`

- [ ] **Step 1: Replace the escape function so its regex only runs on table rows**

In `extensions/llm-wiki/lib/knowledge-document.ts`, replace the current `escapeWikilinkAliasPipes` function (from `/** Escape wikilink alias pipes so generated content remains valid in Markdown tables. */` through its closing `}`) with this version:

```ts
/** Escape wikilink alias pipes only inside Markdown table rows.
 *
 * A bare `|` inside `[[target|alias]]` would be read as a table cell
 * delimiter when the row is rendered, so table rows need the pipe escaped as
 * `[[target\\|alias]]`. Prose, lists, headings, and fenced code keep their
 * pipes literal, so the written file stays valid for external readers
 * (Obsidian, VS Code Wiki Links) that don't understand the escaped form. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

function escapeWikilinkAliasPipes(body: string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // Only table rows (and no-op separator/header rows) get the escape pass.
      return TABLE_ROW.test(line)
        ? line.replace(/\[\[([^\]\n]*?)(?<!\\)\|([^\]\n]*?)\]\]/g, "[[$1\\|$2]]")
        : line;
    })
    .join("\n");
}
```

The key change: the final `return` now guards the `.replace(...)` behind `TABLE_ROW.test(line)`, leaving non-table lines untouched.

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/knowledge-document.test.ts -t "escopes alias-pipe escaping to Markdown table rows only"`

Expected: PASS. The prose assertions now hold because non-table lines are passed through verbatim; the table-row assertion still holds because the escaping still runs on table rows.

- [ ] **Step 3: Commit the fix**

```bash
git add extensions/llm-wiki/lib/knowledge-document.ts
git commit -m "fix: escape wikilink alias pipes only inside Markdown table rows"
```

---

## Task 3: Correct the ingest-worker prose assertion

**Files:**
- Modify: `test/ingest-worker.test.ts`

- [ ] **Step 1: Update the assertion at line ~309 to expect unescaped prose pipes**

Find this block in `test/ingest-worker.test.ts` (inside the `commitSynthesis` "normalize" test, ~line 292-310):

```ts
      expect(res.ok).toBe(true);
      const written = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf8");
      expect(written).toContain("[[concepts/transformer\\|T]]");
```

The source page body is plain prose (`The [[transformer|T]] changed everything.`), so after the fix the pipe is no longer escaped. Change it to:

```ts
      expect(res.ok).toBe(true);
      const written = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf8");
      expect(written).toContain("[[concepts/transformer|T]]");
```

- [ ] **Step 2: Run the ingest-worker test**

Run: `npx vitest run test/ingest-worker.test.ts`

Expected: PASS. (Before this change it would FAIL because the source page now stores the unescaped form.)

- [ ] **Step 3: Commit**

```bash
git add test/ingest-worker.test.ts
git commit -m "test: expect unescaped wikilink pipes in prose source pages"
```

---

## Task 4: Full verification and commit sweep

**Files:**
- (none new)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass. If anything else fails, it is encoding the old escaping behavior — update that assertion to the correct (unescaped-for-prose) expectation.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: clean (no diagnostics).

- [ ] **Step 3: Lint**

Run: `pnpm lint`

Expected: clean (no lint errors).

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "test: full suite, typecheck, lint green for alias-pipe fix"
```

Expected: working tree clean.

---

## Self-Review Checklist

1. **Spec coverage:** The issue (escaped `\|` in prose breaks external readers) is covered by Task 2's fix and Task 1's regression test. The ingest-worker regression is covered by Task 3.
2. **Placeholder scan:** No TBD/TODO/“implement later” markers. Every step has concrete code and exact commands.
3. **Type consistency:** `escapeWikilinkAliasPipes` keeps its `(body: string) => string` signature; `TABLE_ROW` is `RegExp`. Call sites unchanged.
4. **Phase boundary health:** After Task 2 the project is still green — the reader still handles both escaped and unescaped forms (knowledge-links tests), so no migration or half-done state. The only behavior change is on the write side, which is what the issue targets.

## Verification commands (verbatim)

```bash
npx vitest run test/knowledge-document.test.ts
npx vitest run test/ingest-worker.test.ts
pnpm test
pnpm typecheck
pnpm lint
```
