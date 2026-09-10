# QMD Retrieval Phase 3 Implementation Plan — Retrieval Modes and Recall Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:executing-plans` to implement this plan task-by-task. Track progress with the checkboxes below. Do not start Phase 4 until every required gate passes.

**Goal:** Make QMD the single active relevance engine for explicit `wiki_recall`, automatic `before_agent_start` recall, and MCP, with lexical, hybrid, adaptive, and quality modes plus deterministic fallback. End the dual-engine era: the old heuristic scorer and page-level embedding sidecar leave active recall paths after parity gates pass.

**Architecture:** Keep authoritative Markdown, the validated QMD store lifecycle, and the cache-safe injection boundary from Phase 2 unchanged. Add one shared QMD-backed retrieval service that owns mode selection, fallback chains, score normalization, and layered vault merging. Route the Pi tool, the automatic hook, and MCP through that single service. Recall rendering (links-first, skill/case inlining) stays in the existing `recall.ts` formatting surface, fed by QMD candidates instead of the heuristic scorer. The old scorer survives only in benchmark tooling for transitional comparison, never as a second production ranking path.

**Tech Stack:** TypeScript 5.9, Node.js 22 `node:fs/promises`, `@tobilu/qmd` 2.5.3 public SDK, TypeBox, Vitest, Biome, pnpm.

**Normative inputs:**

- `docs/superpowers/specs/2026-08-08-qmd-retrieval-design.md` (Retrieval Modes, Recall Data Flow, Reranking and Adjustments, Error Handling, Tools and Interfaces, Configuration, Evaluation)
- `docs/superpowers/roadmaps/2026-08-09-qmd-retrieval-roadmap.md` (Phase 3)
- `docs/superpowers/plans/2026-08-09-qmd-retrieval-phase-2-remediation.md` (Phase 2 gates that Phase 3 builds on)

**Phase:** Phase 3. Phase 4 (card-first memory assembly) remains blocked until every gate here passes.

**How to read the code shapes:** each task carries a `**Code shape**` block. These are concrete, codebase-convention-following sketches — the executor adapts them to the exact surrounding types (seam names, `VaultPaths` fields, existing helper exports) and writes the real tests first. Constants (floors, ranks, clamps, thresholds) are normative: change them only through benchmarked code changes.

---

## Baseline

Verified immediately before this plan (branch `qmd-phase-1` at `5a0552b`, PR #144):

```text
Full suite:        725 passed (55 files), 1 model smoke skipped
Typecheck:         pass
Biome lint:        pass
MCP build:         pass
Retrieval baseline: Phase 1 committed baseline unchanged
CodeQL:            0 open alerts on qmd-phase-1 (Analyze pass on 5a0552b)
Mechanical scope:  QMD import isolated to qmd-store.ts; recall.ts/inject.ts untouched since Phase 1
Contract tests:    qmd-contract.test.ts pins the four-mode request shapes against @tobilu/qmd 2.5.3
```

SDK facts the code shapes rely on (pinned `@tobilu/qmd` 2.5.3 `index.d.ts`/`store.d.ts`):

```ts
// BM25, model-free: QMDStore.searchLex(query, { limit?, collection? }) → SearchResult[]
// SearchResult = DocumentResult & { score: number; source: "fts" | "vec"; chunkPos?: number }
// DocumentResult = { filepath, displayPath, title, context, hash, docid, collectionName, modifiedAt, bodyLength, body? }

// Fused: QMDStore.search(options) → HybridQueryResult[]
// HybridQueryResult = { file, displayPath, title, body, bestChunk, bestChunkPos, score, context, docid, explain? }
// SearchOptions = { query? (auto-expands), queries?: ExpandedQuery[] (skips expansion),
//                   intent?, rerank?, collection?, collections?, limit?, candidateLimit?, minScore?, explain?, ... }
// ExpandedQuery = { type: "lex" | "vec" | "hyde"; query: string; line?: number }
```

Mirror layout the mapping depends on (Phase 2): each hit's `file`/`filepath` points inside `<vault>/.llm-wiki/meta/qmd/current/documents/<role>/<pageId>.md`, where `<role>` is `canonical` or `evidence` and `<pageId>` may contain `/` (e.g. `concepts/rag`).

---

## Scope Boundaries

This plan must not:

- change authoritative Markdown, metadata projection, or the write path;
- change the QMD store swap lifecycle, status ladder, or lock semantics from Phase 2;
- import `@tobilu/qmd` outside `extensions/llm-wiki/lib/qmd-store.ts`;
- send the conversational transcript or raw query text into durable feedback events (feedback is Phase 6; query text stays in-process only);
- implement typed-link expansion, canonical/evidence bundle assembly, or contradiction rendering (Phase 4);
- implement conflict resolution (Phase 5) or feedback learning (Phase 6);
- download or load models during ordinary tests, status, lint, or lexical retrieval;
- break the `inject.ts` cache-safety contract (system prompt stays byte-stable; volatile recall content stays in the tail message);
- keep two production ranking paths — the heuristic scorer must leave active recall once parity gates pass, and any transitional comparison lives only in benchmark tooling;
- change `wiki_reindex` input parameters or the QMD manifest/state formats.

A failed or degraded QMD retrieval must fail toward no recall or a cheaper mode, never toward unrelated injected memory. If no candidate clears the confidence floor, recall returns no result — an empty result is a valid successful outcome.

---

## File Responsibility Map

### Production files

- `extensions/llm-wiki/lib/qmd-store.ts` — search methods on the adapter (`searchLex`, `searchTyped`, `searchExpanded`) with the exact SDK mappings from the spec; `QmdSearchHit` result shape. Only this file touches QMD search types.
- `extensions/llm-wiki/lib/retrieval.ts` — NEW shared QMD-backed retrieval service: query normalization, mode resolution, fallback chains, within-store confidence, cross-vault rank-based fusion, exact-match and role adjustments, QMD-hit → `RecallResult` mapping, structured diagnostics. Pure of rendering; model-free when the mode/store allow.
- `extensions/llm-wiki/lib/recall.ts` — route `searchWikiHybrid`/`searchWikiLayered` active callers to the retrieval service; keep `formatRecallContext`, links-first gating, and skill/case inlining as the rendering surface; retire the heuristic scoring internals from active paths after the parity gate.
- `extensions/llm-wiki/lib/task-config.ts` — `retrievalMode` setting with fail-closed validation; default `adaptive`.
- `extensions/llm-wiki/lib/wiki-service.ts` — status additions (resolved retrieval mode, resolved QMD models, index vector health), shared operation used by Pi and MCP.
- `extensions/llm-wiki/index.ts` — `before_agent_start` automatic recall calls the shared service with the precision-first policy.
- `extensions/llm-wiki/lib/tools.ts` — `wiki_reindex_embeddings` delegates to `wiki_reindex` (deprecation), `wiki_status` renders retrieval state.
- `extensions/llm-wiki/lib/embeddings.ts` — retire the page-level embedding sidecar from active recall; keep only what benchmark tooling needs, or mark the module deprecated.
- `mcp/operations.ts` and `mcp/index.ts` — `recallOperation` becomes async over the shared service; MCP `wiki_recall` parity.

### Tests

- `test/qmd-contract.test.ts` — extend to pin the three adapter search methods against the real SDK.
- `test/retrieval.test.ts` — NEW: normalization, mode selection, fallback chains, score normalization, layered merge, diagnostics; model-free via the fake store factory or a temp real lexical store.
- `test/recall.test.ts` — update active-path expectations to QMD candidates; move heuristic-scorer assertions to a benchmark-comparison section or delete with the retired scorer.
- `test/agent-start-injection.test.ts` — automatic precision-first policy: floor, project-only scope, no-injection cases.
- `test/mcp-parity.test.ts` — Pi tool and MCP return structurally equivalent recall results.
- `test/retrieval-benchmark.test.ts` — Phase 3 ablation gates and the old-scorer retirement gate.
- `test/task-config.test.ts` — `retrievalMode` validation and defaults.

### Documentation

- `docs/configuration.md` — `retrievalMode`, `recallFeedback` placeholder note, deprecation note for `wiki_reindex_embeddings`.
- `docs/api.md` — recall diagnostics, modes, fallback behavior.
- `docs/architecture.md` — one retrieval engine, fallback chains, score normalization, layering.
- `docs/troubleshooting.md` or migration docs — first-use model download messaging and lexical-before-vectors behavior.

No change to the manifest/state formats, `wiki_reindex` parameters, or lock semantics.

---

## Task 1: Retrieval Adapter Modes and Contract Verification

**Files:**

- Modify: `extensions/llm-wiki/lib/qmd-store.ts`
- Modify: `test/qmd-contract.test.ts`

- [ ] **Step 1: Define the adapter search surface**

Extend the existing `QmdIndexStore` interface (the object returned by `openQmdIndexStore`) with three methods whose request shapes match the spec's mode mappings exactly. All three return a normalized, SDK-free hit shape:

```ts
// extensions/llm-wiki/lib/qmd-store.ts (inside QmdIndexStore interface)
export interface QmdSearchHit {
  /** Mirror collection the hit came from ("canonical" | "evidence"). */
  collection: "canonical" | "evidence";
  /** Mirror-relative file, e.g. "documents/canonical/concepts/rag.md". */
  file: string;
  title: string;
  /** 0..1, normalized to this result list's max. Within-store confidence only. */
  score: number;
  source: "fts" | "vec";
  /** Best chunk body when the SDK returned one (hybrid results). */
  body?: string;
}

export interface QmdIndexStore {
  // ...existing update/embed/status/close...
  /** lexical: store.searchLex(query, { limit }) — BM25 only, no model load. */
  searchLex(query: string, limit?: number): Promise<QmdSearchHit[]>;
  /** hybrid + adaptive-initial: typed lex/vec queries, NO LLM expansion, NO rerank. */
  searchTyped(query: string, limit?: number): Promise<QmdSearchHit[]>;
  /** adaptive-uncertain + quality: plain query, LLM expansion + rerank, with intent. */
  searchExpanded(query: string, intent: string | undefined, limit?: number): Promise<QmdSearchHit[]>;
}
```

- [ ] **Step 2: Add failing contract tests**

Extend `test/qmd-contract.test.ts` (the file already builds a real temp store and asserts the model cache is untouched by lexical ops):

1. `searchLex` returns BM25 hits without downloading or loading models — assert `modelFiles()` unchanged, mirroring the existing lexical test.
2. `searchTyped` with `rerank: false` and typed `queries` is accepted by the pinned SDK; under `QMD_MODEL_SMOKE=1` it returns fused hits, otherwise assert request-shape only (no model load).
3. `searchExpanded` with `rerank: true` and `intent` is accepted under the model smoke flag; without it, assert the shape only.
4. Result mapping: a hit on a file under `documents/canonical/` yields `collection: "canonical"`, and `file` parses back to the page ID (see `roleFromFile` below). The same for `documents/evidence/`.

- [ ] **Step 3: Implement and verify**

```ts
// extensions/llm-wiki/lib/qmd-store.ts — inside openQmdIndexStore's returned object
function roleFromFile(file: string): QmdSearchHit["collection"] {
  // ".../documents/canonical/concepts/rag.md" → "canonical"; anything else → "evidence"
  return /(?:^|\/)documents\/canonical\//.test(file) ? "canonical" : "evidence";
}

// Map raw SDK results to score-less hits plus their raw score, then normalize
// to 0..1 per list (score = raw / list-max). Raw scores are within-store only.
type RawHit = Omit<QmdSearchHit, "score"> & { raw: number };
function withNormalizedScores(hits: RawHit[]): QmdSearchHit[] {
  const max = Math.max(...hits.map((h) => h.raw), 1e-9);
  return hits.map(({ raw, ...rest }) => ({ ...rest, score: raw / max }));
}

const mapLexHit = (r: SearchResult): RawHit => ({
  collection: roleFromFile(r.filepath),
  file: r.filepath,
  title: r.title,
  source: r.source,
  raw: r.score,
});

// Collect the raw SDK arrays first, map, then normalize:
searchLex: async (query, limit = 40) =>
  withNormalizedScores(
    (await store.searchLex(query, { limit })).map(mapLexHit),
  ),

searchTyped: async (query, limit = 10) =>
  withNormalizedScores(
    (
      await store.search({
        queries: [
          { type: "lex", query },
          { type: "vec", query },
        ],
        rerank: false,
        candidateLimit: 40,
        limit,
        explain: true,
      })
    ).map((r: HybridQueryResult): RawHit => ({
      collection: roleFromFile(r.file),
      file: r.file,
      title: r.title,
      source: "fts" as const,
      body: r.bestChunk,
      raw: r.score,
    })),
  ),

searchExpanded: async (query, intent, limit = 10) =>
  withNormalizedScores(
    (
      await store.search({
        query,
        intent: intent ?? undefined,
        rerank: true,
        candidateLimit: 40,
        limit,
        explain: true,
      })
    ).map((r: HybridQueryResult): RawHit => ({
      collection: roleFromFile(r.file),
      file: r.file,
      title: r.title,
      source: "fts" as const,
      body: r.bestChunk,
      raw: r.score,
    })),
  ),
```

Keep `SearchResult`/`HybridQueryResult` imports type-only, and add nothing else to the module's QMD exposure.

Verify: `pnpm typecheck`, `pnpm lint`, `QMD_FORCE_CPU=1` vitest over `qmd-contract.test.ts` (model-free tests green; model smoke skipped), full suite green.

**Verification:** each adapter method maps to exactly its spec SDK call; lexical search stays model-free; no new QMD import site.

---

## Task 2: Shared QMD Retrieval Service

**Files:**

- Add: `extensions/llm-wiki/lib/retrieval.ts`
- Modify: `test/recall.test.ts` (or new `test/retrieval.test.ts`)

- [ ] **Step 1: Add failing mode/fallback tests (model-free)**

Using the existing fake store factory (or a temp real lexical store), pin:

1. Query normalization: NFKC-normalize, trim, collapse whitespace; punctuation, quoted phrases, path separators, and identifier characters preserved; empty query → no results; input over 2,000 chars → `recall_query_too_long` diagnostic, never truncated.
2. Mode selection: `lexical` always calls `searchLex`; `hybrid` always calls `searchTyped`; `quality` always calls `searchExpanded`, then falls back through `searchTyped` to `searchLex`; `adaptive` starts with `searchTyped` and escalates only when a trigger fires — otherwise stays hybrid.
3. Fallback chains per the spec error table: vectors missing/stale → BM25 with a stale-vector diagnostic; embedding model load failure → lexical; reranker failure/timeout → keep the fused hybrid list; store cannot open → automatic policy injects nothing, explicit policy returns a structured diagnostic.
4. Exact-match bypass: exact title, alias, command, filename, or page-ID match with normalized score `>= 0.80` skips reranking.
5. Adaptive trigger math as pure functions with pinned examples: `jaccardOverlap(["a","b","c"], ["a","d","e"]) === 1/5`; a two-hit list with normalized margin `0.07` escalates, `0.12` does not; `interrogativePrefix("who designed the cache")` is true, `interrogativePrefix("cached response design")` is false.
6. The contradiction-edge adaptive trigger is a no-op hook this phase (typed relations arrive in Phase 4); assert the hook exists and never fires on a store with no relation projection.
7. `intent` is `topic` + `mode` from config capped at 256 chars, omitted when both are absent; the transcript never reaches the adapter.

- [ ] **Step 2: Implement the service**

```ts
// extensions/llm-wiki/lib/retrieval.ts — pure pieces first (exported for tests)

export type RetrievalMode = "lexical" | "hybrid" | "adaptive" | "quality";
export type RecallPolicy = {
  /** automatic: false (project only); explicit: true (personal + project) */
  includePersonal: boolean;
  /** normalized floor: automatic 0.50, explicit 0.25 */
  minScore: number;
  /** max candidates per vault: 10 */
  maxPerVault: number;
  /** injected result cap: automatic 3, explicit caller max_results */
  maxResults: number;
};

// ── query normalization (spec: NFKC, trim, collapse ws, keep punctuation) ──
export const QUERY_MAX_CHARS = 2_000;
export function normalizeQuery(raw: string): string | null {
  const q = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (q.length === 0 || q.length > QUERY_MAX_CHARS) return null; // empty → no result; too long → diagnostic
  return q;
}

// ── adaptive triggers (spec constants) ──
const INTERROGATIVE_PREFIXES = [
  "who", "what", "when", "where", "why", "how", "which", "compare", "explain",
];
export function interrogativePrefix(query: string): boolean {
  const first = query.split(/\s+/)[0]?.toLowerCase();
  return first !== undefined && INTERROGATIVE_PREFIXES.includes(first);
}
export function jaccardOverlap(a: string[], b: string[]): number {
  const aset = new Set(a);
  const bset = new Set(b);
  const intersection = [...aset].filter((x) => bset.has(x)).length;
  const union = new Set([...aset, ...bset]).size;
  return union === 0 ? 1 : intersection / union;
}
/** Normalized margin + lexical/vector overlap; contradiction-edge hook no-ops until Phase 4. */
export function shouldEscalate(
  query: string,
  hits: QmdSearchHit[],
  hasContradictionEdge: () => boolean = () => false,
): boolean {
  const lex = hits.filter((h) => h.source === "fts").slice(0, 5).map((h) => h.file);
  const vec = hits.filter((h) => h.source === "vec").slice(0, 5).map((h) => h.file);
  const margin = hits.length >= 2 ? hits[0].score - hits[1].score : 1;
  return (
    margin < 0.08 ||
    jaccardOverlap(lex, vec) < 0.40 ||
    interrogativePrefix(query) ||
    hasContradictionEdge()
  );
}

// ── mode execution + fallback chains (spec table) ──
const MODE_FALLBACKS: Record<RetrievalMode, RetrievalMode[]> = {
  lexical: [],                    // no lower mode; native/store failure → diagnostic
  hybrid: ["lexical"],
  adaptive: ["lexical"],          // initial hybrid → searchLex on failure
  quality: ["hybrid", "lexical"], // expanded/reranked → typed hybrid → lexical
};

async function executeMode(
  store: QmdIndexStore,
  mode: RetrievalMode,
  query: string,
  intent: string | undefined,
): Promise<QmdSearchHit[]> {
  switch (mode) {
    case "lexical":
      return store.searchLex(query);
    case "hybrid":
      return store.searchTyped(query);
    case "quality":
      return store.searchExpanded(query, intent);
    case "adaptive": {
      const initial = await store.searchTyped(query);
      if (exactMatchBypass(query, initial)) return initial;
      if (shouldEscalate(query, initial)) {
        try {
          return await store.searchExpanded(query, intent);
        } catch {
          return initial; // retain initial hybrid list on reranker failure
        }
      }
      return initial;
    }
  }
}

export async function retrieveStore(
  store: QmdIndexStore,
  mode: RetrievalMode,
  query: string,
  intent: string | undefined,
): Promise<{ hits: QmdSearchHit[]; trace: string[] }> {
  const trace: string[] = [];
  for (const m of [mode, ...MODE_FALLBACKS[mode]]) {
    try {
      const hits = await executeMode(store, m, query, intent);
      if (m !== mode) trace.push(`fallback:${mode}->${m}`);
      return { hits, trace };
    } catch (error) {
      trace.push(`failed:${m}:${(error as Error).message}`);
    }
  }
  return { hits: [], trace }; // caller policy decides: auto → inject nothing, explicit → diagnostic
}

/** Exact title/alias/command/filename/page-ID match with normalized score ≥ 0.80 bypasses reranking. */
export function exactMatchBypass(query: string, hits: QmdSearchHit[]): boolean {
  const q = normalizeQuery(query)?.toLowerCase();
  if (!q) return false;
  return hits.some((h) => {
    const id = pageIdFromFile(h.file).toLowerCase();
    const title = h.title.toLowerCase();
    return (id === q || title === q) && h.score >= 0.8;
  });
}

// ── cross-vault fusion (spec: reciprocal rank, project precedence) ──
const RANK_OFFSET = 60;
function reciprocalRank(rank: number): number {
  return 1 / (RANK_OFFSET + rank); // 1/(60+rank), rank 0-based
}

export function pageIdFromFile(file: string): string {
  // ".../documents/canonical/concepts/rag.md" → "concepts/rag" (pageId may contain "/")
  const m = /(?:^|\/)documents\/(?:canonical|evidence)\/(.+)\.md$/.exec(file);
  return m?.[1] ?? file;
}

export function fuseLayers(layers: Array<{ vaultLabel?: string; hits: QmdSearchHit[] }>): RecallResult[] {
  const best = new Map<string, { hit: QmdSearchHit; rr: number; rank: number; vaultLabel?: string }>();
  for (const layer of layers) {
    layer.hits.forEach((hit, rank) => {
      const id = pageIdFromFile(hit.file);
      const rr = reciprocalRank(rank);
      const prev = best.get(id);
      // Greater rr wins; on a tie the PROJECT layer wins (project has no vaultLabel).
      if (!prev || rr > prev.rr || (rr === prev.rr && layer.vaultLabel === undefined)) {
        best.set(id, { hit, rr, rank, vaultLabel: layer.vaultLabel });
      }
    });
  }
  return [...best.values()]
    .sort((a, b) => b.rr - a.rr || a.rank - b.rank || a.hit.file.localeCompare(b.hit.file))
    .map(({ hit, rr, vaultLabel }) => toRecallResult(hit, rr, vaultLabel));
}

// ── bounded final multiplier (spec clamp 0.90–1.10; feedback ±0.02 is a zeroed Phase 6 hook) ──
export function boundedMultiplier(
  isExactMatch: boolean,
  role: "canonical" | "evidence",
  deprecated: boolean,
): number {
  let m = 1;
  if (isExactMatch) m += 0.05;
  if (role === "canonical") m += 0.03;
  if (role === "evidence") m -= 0.02;
  if (deprecated) m -= 0.08;
  return Math.min(1.1, Math.max(0.9, m));
}
```

The orchestrating entry point, `recallWiki(paths, rawQuery, { policy, config, signal })`:

```ts
// 1. normalizeQuery(rawQuery) — null → return { results: [], diagnostics: [{ code: "recall_query_too_long" | "recall_query_empty", message }] }
// 2. resolve applicable vaults:
//      automatic: active project vault if one exists (resolveVaultPaths(cwd) != personal), else personal
//      explicit:   project (if any) AND personal (~/.llm-wiki), unless primary IS personal
// 3. per vault: readQmdIndexStatus(paths) — not ready → automatic: skip vault silently; explicit: collect diagnostic
// 4. per vault: openQmdIndexStore({ dbPath: join(paths.qmdCurrent, "index.sqlite"), documentsPath: paths.qmdDocuments }),
//      retrieveStore(store, mode, query, intent), close() in finally
//    intent = [config.topic, config.mode].filter(Boolean).join(" ").slice(0, 256) || undefined
// 5. per vault: apply policy.minScore floor on normalized rr * boundedMultiplier(...) — strict >, floor applies to the FINAL score
// 6. fuseLayers(vaultLayers) → cap to policy.maxResults
// 7. map each fused hit to RecallResult via toRecallResult: id = pageIdFromFile, path = manifest entry
//    sourcePath (readQmdManifest(paths, vaultId)) else join(paths.wiki, `${id}.md`),
//    title/type/preview from the authoritative page (reuse parsePage/preview helpers from recall.ts),
//    score = final bounded score, vaultLabel for personal hits
// 8. return { results, diagnostics, trace, mode }
```

`toRecallResult` reuses the existing `RecallResult` shape from `recall.ts` (`id, title, type, preview, path, vaultLabel?, score`) so rendering stays untouched. Do NOT open the store when status is not ready (matches Phase 2's status contract).

- [ ] **Step 3: Verify**

`pnpm typecheck`, `pnpm lint`, focused vitest over the new tests plus `recall.test.ts` and `qmd-indexing.test.ts` (status reads unchanged). Full model-free QMD suite must stay green.

**Verification:** each mode invokes only its specified SDK path (asserted via the adapter seam or request recording); every failure path lands on its designed fallback; no model load outside `QMD_MODEL_SMOKE=1` paths.

---

## Task 3: Retrieval Mode Configuration and Status

**Files:**

- Modify: `extensions/llm-wiki/lib/task-config.ts`
- Modify: `extensions/llm-wiki/lib/wiki-service.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `test/task-config.test.ts`

- [ ] **Step 1: Add failing config/status tests**

1. `retrievalMode: "lexical" | "hybrid" | "adaptive" | "quality"` parses; invalid explicit values (`"fuzzy"`, `"vector"`, numbers) are dropped and the default applies — the setting must never disable recall or crash the hook.
2. Default is `adaptive` when the setting is absent.
3. `wiki_status` reports: resolved retrieval mode, resolved QMD embed/generate/rerank model IDs (from `resolveQmdModels`), and vector index health (`hasVectorIndex`), without opening the store.

- [ ] **Step 2: Implement**

```ts
// extensions/llm-wiki/lib/task-config.ts
export const RETRIEVAL_MODES = ["lexical", "hybrid", "adaptive", "quality"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

// in the interface:
retrievalMode?: RetrievalMode;

// in readNamespacedConfig(), matching the existing silent-drop pattern
// (invalid values are not applied — same convention as synthesisLanguage):
const mode = section.retrievalMode;
if (typeof mode === "string" && (RETRIEVAL_MODES as readonly string[]).includes(mode)) {
  out.retrievalMode = mode as RetrievalMode;
}
```

```ts
// extensions/llm-wiki/lib/wiki-service.ts — extend the status object readQmdIndexStatus
// already produces (qmdIndexing readQmdIndexStatus paths) with, in getWikiStatus:
retrievalMode: config?.retrievalMode ?? "adaptive",
qmdModels: resolveQmdModels(),          // embed/generate/rerank strings; no download
// hasVectorIndex already on qmd status from Phase 2 — surface it in the tool output
```

`tools.ts`: render the new fields in `wiki_status` output text (mode, models, vector health) — read-only, no store open. The retrieval service defensively treats any unknown internal mode as `adaptive`.

- [ ] **Step 3: Verify**

Focused vitest over `task-config.test.ts`, `qmd-indexing.test.ts`, and `lint-okf.test.ts`; typecheck; lint.

**Verification:** invalid mode values never reach the retrieval service as an unknown mode; status stays model-free and store-open-free.

---

## Task 4: Recall Cutover — Pi, MCP, Automatic

**Files:**

- Modify: `extensions/llm-wiki/lib/recall.ts`
- Modify: `extensions/llm-wiki/index.ts`
- Modify: `mcp/operations.ts`, `mcp/index.ts`
- Modify: `test/recall.test.ts`, `test/agent-start-injection.test.ts`, `test/mcp-parity.test.ts`

- [ ] **Step 1: Add failing cutover tests**

1. `wiki_recall` (Pi tool) returns QMD-backed candidates with the explicit policy: both vaults when both exist, reciprocal-rank fusion, project tie precedence, `0.25` normalized floor, `max_results` default 5 / max 10.
2. `wiki_recall` returns a structured diagnostic (not a crash) when the QMD store cannot open, and returns "no reliable memory" (not weak candidates) when nothing clears the floor.
3. Automatic `before_agent_start` recall uses the precision-first policy: active project only, at most 10 candidates per vault, normalized floor `0.50`, at most 3 injected results, nothing injected below the floor, and the existing links-first/skill-inline rendering unchanged when results exist.
4. MCP `wiki_recall` returns structurally equivalent results to the Pi tool for the same vault and query (same ids, order, scores, vault labels, diagnostics).
5. The cache-safe split is preserved: recall results still travel in the volatile tail message, never in the system prompt (existing `agent-start-injection` assertions keep passing with the new recall backend).

- [ ] **Step 2: Route the Pi tool and automatic hook**

```ts
// extensions/llm-wiki/lib/recall.ts — registerWikiRecall execute body (explicit policy):
const policy = {
  includePersonal: true,
  minScore: 0.25, // QMD normalized floor, spec
  maxPerVault: 10,
  maxResults: Math.min(params.max_results ?? 5, 10),
};
const { results, diagnostics } = await recallWiki(paths, params.query, {
  policy,
  config: runtime?.config,
  signal,
});
// keep: no-vault guard, empty-result message ("No wiki pages found…" + diagnostics),
//       links-first gate (shouldUseLinksFirst), formatRecallContext rendering, details payload
```

```ts
// extensions/llm-wiki/index.ts — before_agent_start (automatic, precision-first):
const policy = { includePersonal: false, minScore: 0.5, maxPerVault: 10, maxResults: 3 };
const { results } = await recallWiki(paths, prompt, { policy, config: runtime.config });
// keep: formatRecallContext links-only gate, status-line notice, buildAgentStartInjection tail delivery
```

- [ ] **Step 3: Route MCP**

```ts
// mcp/operations.ts — recallOperation becomes async over the shared service:
export async function recallOperation(
  paths: VaultPaths,
  query: string,
  maxResults = 5,
): Promise<{ results: RecallResult[]; diagnostics: Array<{ code: string; message: string }> }> {
  const { results, diagnostics } = await recallWiki(paths, query, {
    policy: { includePersonal: true, minScore: 0.25, maxPerVault: 10, maxResults: Math.min(maxResults, 10) },
  });
  const vaultState = inspectVaultFormat(paths); // existing format diagnostics appended
  return { results, diagnostics: [...diagnostics, ...vaultState.diagnostics.map((d) => ({ code: d.code, message: d.message }))] };
}
```

`mcp/index.ts` `wiki_recall` already awaits `recallOperation` — update the description only (results shape unchanged). Keep `searchOperation` (`wiki_search`) as the fast exact registry lookup, untouched.

- [ ] **Step 4: Verify parity**

Run `test/mcp-parity.test.ts`, `test/agent-start-injection.test.ts`, `test/recall.test.ts`, and the okf-integration suite. Pi and MCP must emit equivalent structured candidates; the automatic hook must inject nothing below the floor and nothing in a session with no vault.

**Verification:** all four surfaces (Pi tool, MCP, automatic hook, rendering) share one retrieval path; no caller still reaches the heuristic scorer for production recall.

---

## Task 5: Deprecation and Scorer Retirement

**Files:**

- Modify: `extensions/llm-wiki/lib/tools.ts` (`wiki_reindex_embeddings`)
- Modify: `extensions/llm-wiki/lib/embeddings.ts`
- Modify: `extensions/llm-wiki/lib/recall.ts` (retire heuristic internals from active paths)
- Modify: `test/retrieval-benchmark.test.ts`, `test/embeddings.test.ts`

- [ ] **Step 1: Deprecate `wiki_reindex_embeddings`**

The tool delegates to the shared reindex operation; behavior for the same inputs is identical modulo the notice:

```ts
// extensions/llm-wiki/lib/tools.ts — registerWikiReindexEmbeddings.execute body:
// (keep the vault check, then:)
const result = await reindexWiki(paths, {
  scope: "all",
  components: ["vectors"],
  force: params.force === true,
  vault: "active",
});
const deprecation =
  "⚠️ wiki_reindex_embeddings is deprecated — use wiki_reindex (lexical/vector, changed/all, per-vault). " +
  "It delegates to wiki_reindex for one major release cycle.";
return { content: [{ type: "text", text: `${deprecation}\n\n${summaryText(result)}` }], details: result };
```

Update the description/promptSnippet/promptGuidelines to say deprecated. `test/qmd-reindex-tool.test.ts` and MCP parity cover the delegation (identical behavior modulo the notice).

- [ ] **Step 2: Retire the old scorer from active paths**

Remove heuristic scoring, the page-level embedding sidecar read (`readEmbeddingStore`), and `searchWiki`/`searchWikiLayered`/`searchWikiHybrid` from production call sites after the parity gate passes. Keep only what benchmark tooling needs for transitional comparison, explicitly labeled and never imported by `recall.ts`, `index.ts`, `wiki-service.ts`, or MCP. `wiki_search` (exact registry lookup) remains.

- [ ] **Step 3: Run the ablation gates**

Extend `test/retrieval-benchmark.test.ts` to record and gate, against the Phase 1 committed baseline:

1. QMD lexical and QMD hybrid/adaptive/quality results (quality and adaptive under `QMD_MODEL_SMOKE=1`) versus the heuristic baseline; exact-lookup results stay within release-gate tolerance.
2. No regression on exact identifier/title/alias lookups (the strongest historical recall failure mode).
3. Automatic-recall false-positive rate: nothing injected below the floor.

If a gate fails, return to the owning task rather than weakening the criterion.

- [ ] **Step 4: Verify + docs**

Update `docs/configuration.md` (retrievalMode, deprecation), `docs/api.md` (recall diagnostics and modes), `docs/architecture.md` (single engine, fallback chains, normalization), and migration/troubleshooting notes (first-use model download messaging; lexical recall available before vectors finish). Full suite, typecheck, lint, `build:mcp`, `benchmark:retrieval`.

**Verification:** no production import chain reaches the retired scorer; `wiki_reindex_embeddings` and `wiki_reindex` behave identically for the same inputs; the benchmark report records all ablations with model/index versions.

---

## Task 6: Certification

**Files:**

- All of the above.

- [ ] **Step 1: Model-free gates**

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-mirror.test.ts test/qmd-contract.test.ts \
  test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts test/qmd-reindex-tool.test.ts \
  test/retrieval.test.ts test/recall.test.ts test/lint-okf.test.ts
```

All pass, model smoke skipped, no unexpected stderr warnings.

- [ ] **Step 2: Full gates**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build:mcp
pnpm benchmark:retrieval
git diff --check 2ff868c..HEAD
```

- [ ] **Step 3: Mechanical scope verification**

`git diff 2ff868c..HEAD` shows: no `inject.ts` cache-safety contract change; no `@tobilu/qmd` import outside `lib/qmd-store.ts`; no manifest/state format change; no change to `wiki_reindex` parameters; heuristic scorer reachable only from benchmark tooling.

- [ ] **Step 4: Optional real-model smoke**

`QMD_MODEL_SMOKE=1 QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts test/retrieval.test.ts` with cached pinned models (approximately 2 GB first-use download; if not run, record as an explicit release-risk note rather than claiming model-backed verification).

- [ ] **Step 5: Push and certify**

Push `qmd-phase-1`; confirm PR #144 checks (CodeQL, quality, package smoke, MCP parity) pass; record the benchmark report and any release-risk notes. After certification, create a separate Phase 4 (Card-First Memory Assembly) plan — do not fold Phase 4 into this one.

**Verification:** every gate green; single active retrieval engine; retrieval benchmark reports QMD ablations; docs match actual tool behavior.

---

## Release-Risk Notes (tracked here, not deferred)

- First-use model download is approximately 2 GB (default embedding, expansion, and reranker models) and happens only on vector/hybrid/adaptive-escalation/quality paths; lexical retrieval works with zero downloads. Document and surface progress/cancellation per the spec's error-handling section.
- Adaptive escalation and quality-mode verification depend on a real model run; without `QMD_MODEL_SMOKE=1` the plan certifies shapes and fallbacks, not end-to-end reranked scores.
- Cold-latency: a per-call store open/close may add measurable latency to first recall after idle. If the benchmark shows a cold-start regression beyond tolerance, add an open-store cache inside the retrieval service as a follow-up task — but only with benchmark evidence.
- The `recallFeedback` setting is not implemented this phase (Phase 6); the config surface may document it as reserved to avoid a later breaking config addition.
