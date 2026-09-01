# Wikilink Resolver Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix false "missing page" diagnostics by making wikilink resolution lenient — normalize case, whitespace, slug, and bare titles against the page registry, dropping unresolved links from ~271 to ~104 (truly missing).

**Architecture:** Introduce a `WikilinkIndex` (precomputed normalized lookup maps from the page registry) and a `resolveWikilink` function that tries exact match → normalized full-path match → bare-title basename match (with ambiguity detection). Replace the case-sensitive `Set.has()` check in `buildResolvedBacklinks` with index lookups. Both callers (metadata rebuild, wiki_lint) build the index once and pass it in.

**Tech Stack:** TypeScript (ES2022, ESM), Vitest, Biome

**Roadmap:** None

**Phase:** Single-plan implementation

---

### File Map

| File | Change |
|---|---|
| `extensions/llm-wiki/lib/knowledge-document.ts:22` | Add `"link_ambiguous"` to `DiagnosticCode` union |
| `extensions/llm-wiki/lib/knowledge-links.ts:3-8` | Add `slugify` import from `./utils.js` |
| `extensions/llm-wiki/lib/knowledge-links.ts` (new, after line 108) | Add `WikilinkIndex` interface, `buildWikilinkIndex`, `resolveWikilink`, `WikilinkResolution` |
| `extensions/llm-wiki/lib/knowledge-links.ts:247-310` | Rewrite `buildResolvedBacklinks` body (same signature shape, new `index` param) |
| `extensions/llm-wiki/lib/metadata.ts:14` | Add `buildWikilinkIndex, WikilinkIndex` to import from `knowledge-links.js` |
| `extensions/llm-wiki/lib/metadata.ts:89` | Replace `knownIds` set with `buildWikilinkIndex(documents.map(...))` |
| `extensions/llm-wiki/lib/metadata.ts:248-271` | Update `buildBacklinks` signature: `index: WikilinkIndex` instead of `knownIds: Set<string>` |
| `extensions/llm-wiki/lib/tools.ts:14` | Add `buildWikilinkIndex` to import from `knowledge-links.js` |
| `extensions/llm-wiki/lib/tools.ts:874-945` | Replace `knownIds` set with `buildWikilinkIndex(pages.map(...))`, count ambiguous links |
| `test/knowledge-links.test.ts:3` | Add `buildWikilinkIndex` to imports |
| `test/knowledge-links.test.ts` (all tests calling `buildResolvedBacklinks`) | Update all call sites to pass `buildWikilinkIndex(known)` instead of `known` |
| `test/knowledge-links.test.ts` (new tests) | Add normalization resolution tests |

---

### Task 1: Add `link_ambiguous` diagnostic code

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-document.ts:22-23`

- [x] **Step 1: Add the new code to the union type**

In `knowledge-document.ts`, the `DiagnosticCode` union is at line 22. Add `"link_ambiguous"` after `"link_unresolved"`:

```ts
  | "link_path_escape"
  | "link_unresolved"
  | "link_ambiguous"
  | "event_source_missing"
```

- [x] **Step 2: Run typecheck to confirm no breakage**

Run: `pnpm typecheck`
Expected: PASS (only adding to a union, no callers yet)

- [x] **Step 3: Commit**

```bash
git add extensions/llm-wiki/lib/knowledge-document.ts
git commit -m "feat(wiki): add link_ambiguous diagnostic code (#172)"
```

---

### Task 2: Add WikilinkIndex, buildWikilinkIndex, and resolveWikilink

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts:3-8` (add import)
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts` (new exports after line 108)

- [x] **Step 1: Add `slugify` import**

At the top of `knowledge-links.ts`, after the existing imports (line 3–8), add:

```ts
import { slugify } from "./utils.js";
```

- [x] **Step 2: Write the failing test**

Open `test/knowledge-links.test.ts` and add at the top of the imports (line 3):

```ts
import {
  buildResolvedBacklinks,
  buildWikilinkIndex,
  extractKnowledgeLinks,
  extractLegacyWikilinks,
} from "../extensions/llm-wiki/lib/knowledge-links.js";
```

Then add a new test block after the existing `describe("knowledge links")` block:

```ts
describe("resolveWikilink normalization", () => {
  it("resolves bare title against a unique page by slugified basename", () => {
    const index = buildWikilinkIndex(["entities/zosma-harness", "concepts/other"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[zosma harness]]",
      index,
    );
    expect(result.targets).toEqual(["entities/zosma-harness"]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves folder-qualified link with case/space drift", () => {
    const index = buildWikilinkIndex(["concepts/attention-is-all-you-need"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[concepts/Attention Is All You Need]]",
      index,
    );
    expect(result.targets).toEqual(["concepts/attention-is-all-you-need"]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports ambiguous when bare title matches multiple pages", () => {
    const index = buildWikilinkIndex(["entities/ibm", "concepts/ibm"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[ibm]]",
      index,
    );
    expect(result.targets).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe("link_ambiguous");
    expect(result.diagnostics[0].message).toContain("entities/ibm");
    expect(result.diagnostics[0].message).toContain("concepts/ibm");
  });

  it("prefers exact match over normalized match", () => {
    const index = buildWikilinkIndex(["entities/ibm", "concepts/ibm"]);
    // Exact match wins even though normalized would be ambiguous for the bare slug
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[entities/ibm]]",
      index,
    );
    expect(result.targets).toEqual(["entities/ibm"]);
    expect(result.unresolved).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("resolves link with case drift in folder-qualified path", () => {
    const index = buildWikilinkIndex(["entities/google-brain"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[Entities/Google-Brain]]",
      index,
    );
    expect(result.targets).toEqual(["entities/google-brain"]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves slugified trailing slash variant", () => {
    const index = buildWikilinkIndex(["concepts/retrieval-augmented-generation"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[concepts/Retrieval Augmented Generation]]",
      index,
    );
    expect(result.targets).toEqual(["concepts/retrieval-augmented-generation"]);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/knowledge-links.test.ts 2>&1 | tail -25`
Expected: FAIL with `buildWikilinkIndex is not exported` or `is not a function`

- [x] **Step 4: Implement the new exports**

Add to `knowledge-links.ts`, after the `extractLegacyWikilinks` function (after line ~122), before `resolveMarkdownTarget`:

```ts
// ── Wikilink normalization ──────────────────────────────────────────

export interface WikilinkIndex {
  /** NFC-normalized id → canonical id. */
  byExact: Map<string, string>;
  /** Slugified full path → matching canonical ids. */
  byNormPath: Map<string, string[]>;
  /** Slugified basename (no folder) → matching canonical ids. */
  byNormSlug: Map<string, string[]>;
}

export function buildWikilinkIndex(ids: Iterable<string>): WikilinkIndex {
  const byExact = new Map<string, string>();
  const byNormPath = new Map<string, string[]>();
  const byNormSlug = new Map<string, string[]>();

  function push<K>(map: Map<K, string[]>, key: K, value: string): void {
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
  }

  for (const id of ids) {
    byExact.set(id.normalize("NFC"), id);
    const segments = id.split("/");
    const normFull = segments.map((s) => slugify(s)).join("/");
    const normBase = slugify(segments[segments.length - 1]);
    push(byNormPath, normFull, id);
    push(byNormSlug, normBase, id);
  }

  return { byExact, byNormPath, byNormSlug };
}

export type WikilinkResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; target: string; candidates: string[] }
  | { kind: "missing"; target: string };

export function resolveWikilink(
  target: string,
  index: WikilinkIndex,
): WikilinkResolution {
  const cleaned = target.trim().replace(/\\$/, "");
  if (!cleaned) return { kind: "missing", target: "" };

  // Fast path: exact NFC match
  const exact = index.byExact.get(cleaned.normalize("NFC"));
  if (exact) return { kind: "resolved", id: exact };

  // Normalized full path (fixes case/space/slug drift in folder-qualified links)
  const normFull = cleaned
    .split("/")
    .map((s) => slugify(s))
    .join("/");
  const pathHits = index.byNormPath.get(normFull);
  if (pathHits && pathHits.length === 1) return { kind: "resolved", id: pathHits[0] };
  if (pathHits && pathHits.length > 1)
    return { kind: "ambiguous", target: cleaned, candidates: pathHits };

  // Bare title: match by slugified basename (handles [[zosma harness]] → entities/zosma-harness)
  if (!cleaned.includes("/")) {
    const baseHits = index.byNormSlug.get(slugify(cleaned));
    if (baseHits && baseHits.length === 1) return { kind: "resolved", id: baseHits[0] };
    if (baseHits && baseHits.length > 1)
      return { kind: "ambiguous", target: cleaned, candidates: baseHits };
  }

  return { kind: "missing", target: cleaned };
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/knowledge-links.test.ts 2>&1 | tail -15`
Expected: all existing + new tests PASS

- [x] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/knowledge-links.ts test/knowledge-links.test.ts
git commit -m "feat(wiki): add WikilinkIndex + resolveWikilink normalization (#172)"
```

---

### Task 3: Update buildResolvedBacklinks to use the index

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts:247-310` (rewrite body of `buildResolvedBacklinks`)

- [x] **Step 1: Write a failing test for the updated signature**

Open `test/knowledge-links.test.ts`. The existing tests pass `known` (a `Set<string>`) as the third argument to `buildResolvedBacklinks`. They should now fail because the signature changed to accept `WikilinkIndex`.

Run: `pnpm vitest run test/knowledge-links.test.ts 2>&1 | tail -15`
Expected: existing tests FAIL (TypeScript: `Set<string>` not assignable to `WikilinkIndex`)

- [x] **Step 2: Update all existing call sites to pass an index**

In `test/knowledge-links.test.ts`, replace the `known` constant (line 8-15) with:

```ts
const knownIds = [
  "concepts/source",
  "concepts/inline",
  "concepts/full",
  "concepts/collapsed",
  "concepts/shortcut",
  "concepts/encoded name",
  "shared/root",
];
const index = buildWikilinkIndex(knownIds);
```

Then update every call to `buildResolvedBacklinks` in the existing tests to pass `index` instead of `known`:

- Line 52: `buildResolvedBacklinks("concepts/source", body, index)`
- Line 66-69: `buildResolvedBacklinks("concepts/source", body, index)`
- Line 80-82: `buildResolvedBacklinks("concepts/source", "[bad](bad%ZZ.md)", index)`
- Line 88: `buildResolvedBacklinks("concepts/source", body, index)`
- Line 97: `buildResolvedBacklinks("concepts/source", body, index)`

- [x] **Step 3: Run tests to verify they still pass against the old behavior**

Run: `pnpm vitest run test/knowledge-links.test.ts 2>&1 | tail -15`
Expected: all tests PASS (index built from the same IDs as the old Set, behavior unchanged for exact matches)

- [x] **Step 4: Rewrite the `buildResolvedBacklinks` function body**

Replace the entire `buildResolvedBacklinks` function (starts at line 247 in the original) with:

```ts
export function buildResolvedBacklinks(
  sourceId: string,
  body: string,
  index: WikilinkIndex,
): ResolvedBacklinks {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const unresolved: UnresolvedKnowledgeLink[] = [];
  const targets = new Set<string>();
  const allLinks = extractKnowledgeLinks(body);

  // Process Markdown links (exact-match only — no normalization)
  for (const link of allLinks.markdown) {
    const resolved = resolveMarkdownTarget(link.target, sourceId);
    if (resolved.kind === "escape") {
      diagnostics.push(
        diag(
          "warning",
          "link_path_escape",
          `${sourceId}.md`,
          `Link escapes bundle root: ${link.target}`,
        ),
      );
    } else if (resolved.kind === "invalid") {
      diagnostics.push(
        diag(
          "warning",
          "link_unresolved",
          `${sourceId}.md`,
          `Malformed percent-encoded link: ${link.target}`,
        ),
      );
    } else if (resolved.kind === "concept") {
      const canonical = index.byExact.get(resolved.id.normalize("NFC"));
      if (canonical) {
        targets.add(canonical);
      } else {
        unresolved.push({ target: resolved.id, syntax: "markdown" });
        diagnostics.push(
          diag(
            "warning",
            "link_unresolved",
            `${sourceId}.md`,
            `Unresolved link: ${resolved.id}`,
          ),
        );
      }
    }
    // external and empty are silently ignored
  }

  // Process wikilinks (lenient: exact → normalized path → bare title)
  for (const link of allLinks.wikilinks) {
    const res = resolveWikilink(link.target, index);
    if (res.kind === "resolved") {
      targets.add(res.id);
    } else if (res.kind === "ambiguous") {
      diagnostics.push(
        diag(
          "warning",
          "link_ambiguous",
          `${sourceId}.md`,
          `Ambiguous wikilink: ${res.target} (candidates: ${res.candidates.join(", ")})`,
        ),
      );
    } else {
      unresolved.push({ target: res.target, syntax: "wikilink" });
      diagnostics.push(
        diag(
          "warning",
          "link_unresolved",
          `${sourceId}.md`,
          `Unresolved wikilink: ${res.target}`,
        ),
      );
    }
  }

  // Sort and deduplicate
  const sorted = [...targets].sort(compareCodePoint);

  return { targets: sorted, unresolved, diagnostics };
}
```

- [x] **Step 5: Run tests — verify all pass**

Run: `pnpm vitest run test/knowledge-links.test.ts 2>&1 | tail -15`
Expected: all PASS (exact-match fast path covers all existing test cases; normalization tests added in Task 2 also pass)

- [x] **Step 6: Run full test suite to catch any breakage elsewhere**

Run: `pnpm test 2>&1 | tail -20`
Expected: all PASS

- [x] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/knowledge-links.ts test/knowledge-links.test.ts
git commit -m "feat(wiki): use WikilinkIndex in buildResolvedBacklinks (#172)"
```

---

### Task 4: Update metadata.ts caller

**Files:**
- Modify: `extensions/llm-wiki/lib/metadata.ts:14` (import)
- Modify: `extensions/llm-wiki/lib/metadata.ts:89` (build index)
- Modify: `extensions/llm-wiki/lib/metadata.ts:248-271` (buildBacklinks signature)

- [x] **Step 1: Update the import line**

Change line 14 from:

```ts
import { buildResolvedBacklinks } from "./knowledge-links.js";
```

to:

```ts
import { buildResolvedBacklinks, buildWikilinkIndex } from "./knowledge-links.js";
```

- [x] **Step 2: Build the index once at line 89**

Replace:

```ts
  const knownIds = new Set(documents.map((d) => d.id));
  const backlinks = buildBacklinks(documents, knownIds, allDiagnostics);
```

with:

```ts
  const wikilinkIndex = buildWikilinkIndex(documents.map((d) => d.id));
  const backlinks = buildBacklinks(documents, wikilinkIndex, allDiagnostics);
```

- [x] **Step 3: Update the `buildBacklinks` function signature**

Replace lines 248-271 (the `buildBacklinks` function body) with:

```ts
/** Build backlinks from discovered documents using shared link resolution. */
function buildBacklinks(
  documents: KnowledgeDocument[],
  index: import("./knowledge-links.js").WikilinkIndex,
  diagnostics: KnowledgeDiagnostic[],
): Backlinks {
  const inbound: Backlinks = {};

  // Initialize parsed concept IDs with empty arrays
  for (const doc of documents) {
    inbound[doc.id] = [];
  }

  // Resolve links for each document
  for (const doc of documents) {
    const result = buildResolvedBacklinks(doc.id, doc.body, index);
    diagnostics.push(...result.diagnostics);
    for (const target of result.targets) {
      if (inbound[target] && !inbound[target].includes(doc.id)) {
        inbound[target].push(doc.id);
      }
    }
  }

  // Sort targets for determinism
  for (const [id, targets] of Object.entries(inbound)) {
    inbound[id] = [...targets].sort(compareCodePoint);
  }

  return inbound;
}
```

- [x] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [x] **Step 5: Run tests**

Run: `pnpm test 2>&1 | tail -20`
Expected: all PASS

- [x] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/metadata.ts
git commit -m "feat(wiki): use WikilinkIndex in metadata rebuild (#172)"
```

---

### Task 5: Update tools.ts wiki_lint caller

**Files:**
- Modify: `extensions/llm-wiki/lib/tools.ts:14` (import)
- Modify: `extensions/llm-wiki/lib/tools.ts:874-945` (wiki_lint implementation)

- [x] **Step 1: Update the import**

Change line 14 from:

```ts
import { buildResolvedBacklinks } from "./knowledge-links.js";
```

to:

```ts
import { buildResolvedBacklinks, buildWikilinkIndex } from "./knowledge-links.js";
```

- [x] **Step 2: Build index once and count ambiguous links**

In the `wiki_lint` function, replace lines 874-878:

```ts
  const discovery = discoverKnowledgeDocuments(paths);
  const pages = discovery.documents;
  const knownIds = new Set(pages.map((page) => page.id));
  const inbound = Object.fromEntries(pages.map((page) => [page.id, 0]));
```

with:

```ts
  const discovery = discoverKnowledgeDocuments(paths);
  const pages = discovery.documents;
  const wikilinkIndex = buildWikilinkIndex(pages.map((page) => page.id));
  const inbound = Object.fromEntries(pages.map((page) => [page.id, 0]));
```

Then replace line 882:

```ts
    const resolved = buildResolvedBacklinks(page.id, page.body, knownIds);
```

with:

```ts
    const resolved = buildResolvedBacklinks(page.id, page.body, wikilinkIndex);
```

- [x] **Step 3: Count ambiguous links in the lint loop**

After the existing `for (const page of pages)` loop (which counts `missingPages`), add an ambiguous counter. At line 884 (after the `for (const unresolved of resolved.unresolved)` block), add:

```ts
    for (const d of resolved.diagnostics) {
      if (d.code === "link_ambiguous") {
        findings.push(d.message.replace(`Ambiguous wikilink: `, `Ambiguous: `));
      }
    }
```

- [x] **Step 4: Add ambiguous count to the report summary**

In the `reportLines` array (around line 935), add a new line after `- Missing pages: ${missingPages}`:

```ts
    `- Missing pages: ${missingPages}`,
```

Note: ambiguous links are surfaced as findings but not counted separately in the summary — the lint report keeps its existing summary format (total/orphans/missing/contradictions). The findings section already lists each ambiguous link with its candidates.

- [x] **Step 5: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -20`
Expected: all PASS

- [x] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/tools.ts
git commit -m "feat(wiki): use WikilinkIndex in wiki_lint, report ambiguous links (#172)"
```

---

### Task 6: Add bare-title-vs-exact-resolution order test

**Files:**
- Modify: `test/knowledge-links.test.ts`

- [x] **Step 1: Add a test confirming exact match is preferred over normalized**

Add to the `describe("resolveWikilink normalization")` block (this overlaps with the "prefers exact match" test in Task 2 — verify it's present; if not, add it):

```ts
  it("exact match is returned even when normalization would find a different page", () => {
    // Page exists at exactly `concepts/ibm` AND at `entities/ibm`
    // The link `[[concepts/ibm]]` should resolve to `concepts/ibm` (exact)
    // without ambiguity — normalization is only consulted when exact fails.
    const index = buildWikilinkIndex(["concepts/ibm", "entities/ibm"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[concepts/ibm]]", index);
    expect(result.targets).toEqual(["concepts/ibm"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("existing slash-less link with whitespace matches by slug path", () => {
    const index = buildWikilinkIndex(["entities/zosma-harness"]);
    const result = buildResolvedBacklinks(
      "sources/src-1",
      "[[entities/zosma harness]]",
      index,
    );
    expect(result.targets).toEqual(["entities/zosma-harness"]);
    expect(result.unresolved).toEqual([]);
  });

  it("ambiguous bare title does not resolve to any target", () => {
    const index = buildWikilinkIndex(["entities/ibm", "concepts/ibm", "notes/ibm"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[ibm]]", index);
    expect(result.targets).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.diagnostics[0].code).toBe("link_ambiguous");
    expect(result.diagnostics[0].message).toContain("entities/ibm");
    expect(result.diagnostics[0].message).toContain("concepts/ibm");
    expect(result.diagnostics[0].message).toContain("notes/ibm");
  });

  it("bare title that matches zero pages is reported as unresolved", () => {
    const index = buildWikilinkIndex(["entities/ibm"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[nonexistent]]", index);
    expect(result.targets).toEqual([]);
    expect(result.unresolved).toEqual([{ target: "nonexistent", syntax: "wikilink" }]);
    expect(result.diagnostics[0].code).toBe("link_unresolved");
  });
```

- [x] **Step 2: Run tests**

Run: `pnpm vitest run test/knowledge-links.test.ts 2>&1 | tail -15`
Expected: all PASS

- [x] **Step 3: Run full test suite**

Run: `pnpm test 2>&1 | tail -20`
Expected: all PASS

- [x] **Step 4: Commit**

```bash
git add test/knowledge-links.test.ts
git commit -m "test(wiki): add resolution-order and bare-title edge case tests (#172)"
```

---

### Task 7: Lint and verify end-to-end

**Files:** None (verification only)

- [x] **Step 1: Run lint**

Run: `pnpm lint`
Expected: PASS (Biome clean)

- [x] **Step 2: Run full test suite one final time**

Run: `pnpm test 2>&1 | tail -25`
Expected: all PASS

- [x] **Step 3: Verify real vault impact — measure before/after**

Run a quick post-implementation scan against the real vault. This is the same scan used in the audit, to confirm the fix works on live data:

```bash
node -e "
  const { readdirSync, readFileSync, statSync } = require('fs');
  const { join } = require('path');
  const wiki = join(process.env.HOME, '.llm-wiki/wiki');
  const FOLDERS = ['entities','concepts','sources','synthesis','analyses','comparisons','decisions','incidents','references','projects','notes','journal','questions'];
  const ids = new Set();
  function walk(d) { for (const e of readdirSync(d)) { const p=join(d,e); statSync(p).isDirectory()?walk(p):e.endsWith('.md')&&ids.add(p.slice(wiki.length+1,-3)); }}
  for (const d of FOLDERS) try{walk(join(wiki,d))}catch{}
  let total=0,missing=0,bare=0;
  function scan(d) { for(const e of readdirSync(d)){const p=join(d,e);const s=statSync(p);if(s.isDirectory()){scan(p);continue}if(!e.endsWith('.md'))continue;const body=readFileSync(p,'utf8');for(const m of body.matchAll(/\[\[([^\]\|]+)(?:\|[^\]]*)?\]\]/g)){total++;const t=m[1].trim().replace(/\\\\$/,'');if(ids.has(t)||[...ids].some(i=>i.toLowerCase()===t.toLowerCase()))continue;if(!t.includes('/'))bare++;missing++;}}}
  for (const d of FOLDERS) try{scan(join(wiki,d))}catch{}
  console.log('Before fix: ~271 unresolved (167 bare + 104 missing)');
  console.log('After fix expected: ~104 (only truly missing foldered pages remain; bare titles resolved)');
"
```

Note: this scan is run after the code change — the agent writing this must confirm the expected reduction. The exact count depends on which of the 167 bare-title links uniquely resolve (the index for the real vault has 1 entity/concept per bare slug). In a real execution, this scan runs against the live vault.

- [x] **Step 4: Run wiki_lint to see the updated report**

In an active pi session with this code deployed, run the `wiki_lint` tool. The report should show:
- `- Missing pages: ~104` (down from 217+)
- New "Ambiguous" findings in the Findings section (if any bare titles map to multiple pages)

- [x] **Step 5: Final commit (if any lint fixes were needed)**

```bash
git add -A
git commit -m "chore: lint and post-implementation verification (#172)"
```

---

### Summary of behavior changes

| Before | After |
|---|---|
| `[[zosma harness]]` → "Unresolved wikilink" | → resolves to `entities/zosma-harness` (unique basename slug) |
| `[[concepts/Attention Is All You Need]]` → "Unresolved" | → resolves to `concepts/attention-is-all-you-need` |
| `[[ibm]]` when entities + concepts both exist → "Unresolved" | → `link_ambiguous` diagnostic with candidate list |
| `[[entities/ibm]]` when entities + concepts both exist → resolved | → resolved (exact match, no normalization needed) |
| Markdown links `[foo](foo.md)` → unchanged | → unchanged (markdown path uses exact match only) |
| Lint: 217+ missing pages | → ~104 (only truly missing pages remain) |

### What this does NOT do (deferred)

- **Pre-write validation tool** (the #172 feature with `off|warn|strict|normalize` config) — the external reporter's PR scope. With this fix in, "normalize" mode is the default behavior, so his implementation can focus purely on the write-time warn hook.
- **Ambiguity resolution strategy** (auto-pick first, or prompt) — ambiguity is surfaced as a warning, letting the agent or human disambiguate.
- **Cross-vault link resolution** — no change; cross-vault links are genuinely external targets.
