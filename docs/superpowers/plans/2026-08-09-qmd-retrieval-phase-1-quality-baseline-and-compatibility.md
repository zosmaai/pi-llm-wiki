# QMD Retrieval Phase 1: Quality Baseline and Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible current-retrieval benchmark and prove the published QMD 2.5.3 dependency/runtime contract without changing active recall behavior.

**Architecture:** Keep production recall on the existing `searchWiki` path throughout this phase. Add a deterministic fixture-driven benchmark around that path, pin QMD as an unused runtime dependency, and exercise QMD's public SDK through isolated contract tests. Ordinary CI validates native installation and model-free lexical behavior; a separate cached workflow validates model-backed calls.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Vitest 3, QMD 2.5.3, pnpm 9, GitHub Actions, Markdown fixtures.

**Roadmap:** [`docs/superpowers/roadmaps/2026-08-09-qmd-retrieval-roadmap.md`](../roadmaps/2026-08-09-qmd-retrieval-roadmap.md)

**Phase:** Phase 1: Quality Baseline and QMD Compatibility

---

## Phase Boundary

This plan intentionally does not create persistent QMD vault indexes or route any Pi/MCP/automatic recall through QMD. At completion, current recall remains active and unchanged; QMD is pinned, installable, contract-tested, and ready for Phase 2.

## File Map

**Create:**

- `test/fixtures/retrieval-benchmark/fixture.ts` — sanitized, versioned benchmark pages and 60 graded queries.
- `test/retrieval-benchmark-fixture.test.ts` — fixture completeness, split, category, identity, and privacy checks.
- `test/helpers/retrieval-metrics.ts` — pure information-retrieval metric functions.
- `test/retrieval-metrics.test.ts` — exact metric behavior tests.
- `test/retrieval-benchmark.test.ts` — materializes the fixture, runs current `searchWiki`, and compares the committed baseline.
- `scripts/update-retrieval-baseline.mjs` — cross-platform baseline regeneration entry point.
- `docs/superpowers/benchmarks/phase-1-current-baseline.json` — generated deterministic baseline artifact.
- `test/qmd-contract.test.ts` — QMD SDK type contract, native lexical smoke, and opt-in model smoke.
- `.github/workflows/qmd-model-smoke.yml` — scheduled/manual cached model-backed compatibility check.
- `docs/retrieval-benchmark.md` — benchmark schema, commands, privacy rules, and interpretation.
- `docs/qmd-compatibility.md` — pinned package/runtime/native/model support contract.

**Modify:**

- `package.json` — Node floor, exact QMD dependency, TypeScript peer-compatible version, benchmark scripts.
- `pnpm-lock.yaml` — generated dependency lock update.
- `test/package-structure.test.ts` — package/runtime assertions.
- `.github/workflows/ci.yml` — supported Node matrix and cross-platform QMD native-install job.

**Explicitly unchanged:**

- `extensions/llm-wiki/lib/recall.ts` — remains the active retrieval implementation and benchmark subject.
- `extensions/llm-wiki/index.ts` — automatic recall behavior stays unchanged.
- `mcp/operations.ts` — MCP recall behavior stays unchanged.

---

### Task 1: Pin the next-major runtime and QMD dependency contract

**Files:**
- Modify: `test/package-structure.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the failing package-contract assertions**

Add these assertions inside `it("should have a valid package.json with pi manifest", ...)`, immediately after parsing `pkg`:

```ts
expect(pkg.engines.node).toBe(">=22.0.0");
expect(pkg.dependencies["@tobilu/qmd"]).toBe("2.5.3");
expect(pkg.devDependencies.typescript).toBe("^5.9.3");
expect(pkg.pnpm.onlyBuiltDependencies).toEqual([
  "better-sqlite3",
  "node-llama-cpp",
  "sqlite-vec",
]);
```

- [ ] **Step 2: Run the targeted test and verify the old package contract fails**

Run:

```bash
pnpm exec vitest run test/package-structure.test.ts --reporter=verbose
```

Expected: FAIL because the current engine is `>=18`, QMD and the native-build whitelist are absent, and TypeScript is still `^5.7.0`.

- [ ] **Step 3: Install the exact published QMD package and compatible TypeScript**

Run:

```bash
pnpm add --save-exact @tobilu/qmd@2.5.3
pnpm add --save-dev typescript@^5.9.3
```

Expected: `package.json` contains exact QMD `2.5.3`, TypeScript `^5.9.3`, and `pnpm-lock.yaml` records QMD's native dependencies.

- [ ] **Step 4: Raise the Node.js engine floor and whitelist QMD native builds**

Change only the `engines` block in `package.json` to:

```json
"engines": {
  "node": ">=22.0.0"
}
```

Add a top-level `pnpm` key so pnpm 10+ still runs QMD's native dependency build scripts (QMD's own `pnpm.onlyBuiltDependencies` does not propagate to consumers):

```json
"pnpm": {
  "onlyBuiltDependencies": ["better-sqlite3", "node-llama-cpp", "sqlite-vec"]
}
```

Do not edit `package.json.version`; release versioning belongs to Phase 7 and must use the release script.

- [ ] **Step 5: Run package, type, and package-build checks**

Run:

```bash
pnpm exec vitest run test/package-structure.test.ts --reporter=verbose
pnpm typecheck
pnpm build:mcp
```

Expected: all commands exit 0; QMD remains unused by production code. If the TypeScript 5.9 bump surfaces new diagnostics in existing files, commit those fixes separately before the Task 1 commit.

- [ ] **Step 6: Commit the runtime contract**

```bash
git add package.json pnpm-lock.yaml test/package-structure.test.ts
git commit -m "build: require Node 22 and pin QMD"
```

---

### Task 2: Add the sanitized 60-query benchmark fixture

**Files:**
- Create: `test/fixtures/retrieval-benchmark/fixture.ts`
- Create: `test/retrieval-benchmark-fixture.test.ts`

- [ ] **Step 1: Write the failing fixture-contract test**

Create `test/retrieval-benchmark-fixture.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_VERSION,
  benchmarkPages,
  benchmarkQueries,
} from "./fixtures/retrieval-benchmark/fixture.js";

describe("retrieval benchmark fixture", () => {
  it("contains the approved versioned 60-query train/held-out corpus", () => {
    expect(BENCHMARK_VERSION).toBe(1);
    expect(benchmarkPages).toHaveLength(22);
    expect(benchmarkQueries).toHaveLength(60);
    expect(benchmarkQueries.filter((query) => query.split === "train")).toHaveLength(45);
    expect(benchmarkQueries.filter((query) => query.split === "heldout")).toHaveLength(15);
  });

  it("covers every Phase 1 query category", () => {
    expect(new Set(benchmarkQueries.map((query) => query.category))).toEqual(
      new Set([
        "exact_lookup",
        "entity_alias",
        "paraphrase",
        "vague_recollection",
        "conceptual",
        "graph_scope",
        "evidence_request",
        "temporal",
        "contradiction",
        "conclusion",
        "synthesis",
        "negative",
      ]),
    );
  });

  it("uses unique stable ids and judgments that reference fixture pages", () => {
    const pageIds = new Set(benchmarkPages.map((page) => page.id));
    const queryIds = benchmarkQueries.map((query) => query.id);
    expect(new Set(queryIds).size).toBe(queryIds.length);

    for (const query of benchmarkQueries) {
      expect(query.judgments.length > 0 || query.autoExpectation === "none").toBe(true);
      for (const judgment of query.judgments) expect(pageIds.has(judgment.pageId)).toBe(true);
      for (const pageId of query.expectedConflicts ?? []) expect(pageIds.has(pageId)).toBe(true);
    }
  });

  it("contains no raw home paths, email addresses, or token-shaped secrets", () => {
    const serialized = JSON.stringify({ benchmarkPages, benchmarkQueries });
    expect(serialized).not.toMatch(/\/home\//i);
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serialized).not.toMatch(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/);
  });
});
```

- [ ] **Step 2: Run the fixture test and verify the module is missing**

Run:

```bash
pnpm exec vitest run test/retrieval-benchmark-fixture.test.ts --reporter=verbose
```

Expected: FAIL with a module-resolution error for `fixtures/retrieval-benchmark/fixture.js`.

- [ ] **Step 3: Create the complete benchmark fixture**

Create `test/fixtures/retrieval-benchmark/fixture.ts`:

```ts
export const BENCHMARK_VERSION = 1;

export type BenchmarkRole = "canonical" | "evidence";
export type BenchmarkSplit = "train" | "heldout";
export type AutoExpectation = "hit" | "none";

export interface BenchmarkPage {
  id: string;
  type: string;
  title: string;
  body: string;
  aliases?: string[];
  tags?: string[];
  status?: "draft" | "stable" | "deprecated";
}

export interface BenchmarkJudgment {
  pageId: string;
  grade: 1 | 2 | 3;
  role: BenchmarkRole;
}

export interface BenchmarkQuery {
  id: string;
  text: string;
  category:
    | "exact_lookup"
    | "entity_alias"
    | "paraphrase"
    | "vague_recollection"
    | "conceptual"
    | "graph_scope"
    | "evidence_request"
    | "temporal"
    | "contradiction"
    | "conclusion"
    | "synthesis"
    | "negative";
  split: BenchmarkSplit;
  judgments: BenchmarkJudgment[];
  autoExpectation: AutoExpectation;
  expectedConflicts?: string[];
}

export const benchmarkPages: BenchmarkPage[] = [
  {
    id: "entities/qmd",
    type: "entity",
    title: "QMD",
    aliases: ["Query Markup Documents"],
    tags: ["retrieval", "markdown"],
    status: "stable",
    body: "QMD is an on-device Markdown search engine combining BM25, vector retrieval, reciprocal-rank fusion, and local reranking.",
  },
  {
    id: "concepts/reciprocal-rank-fusion",
    type: "concept",
    title: "Reciprocal Rank Fusion",
    aliases: ["RRF"],
    tags: ["retrieval", "ranking"],
    body: "Reciprocal Rank Fusion combines independently ranked lists by rank instead of adding incomparable BM25 and cosine scores.",
  },
  {
    id: "concepts/hybrid-retrieval",
    type: "concept",
    title: "Hybrid Retrieval",
    tags: ["bm25", "embeddings"],
    body: "Hybrid retrieval joins lexical matching for exact terms with dense semantic retrieval for paraphrases and vague recollection.",
  },
  {
    id: "concepts/canonical-memory-cards",
    type: "concept",
    title: "Canonical Memory Cards",
    tags: ["zettelkasten", "memory"],
    body: "A reviewed canonical card should be returned before raw observations, with source evidence preserved behind the card.",
  },
  {
    id: "concepts/zettelkasten",
    type: "concept",
    title: "Zettelkasten",
    aliases: ["card box method", "卡片盒笔记法"],
    body: "Zettelkasten organizes atomic permanent notes and meaningful links. It is a knowledge model, not a search ranking algorithm.",
  },
  {
    id: "concepts/obsidian-graph-view",
    type: "concept",
    title: "Obsidian Graph View",
    body: "Obsidian Graph View helps people inspect links, clusters, and orphan notes. It visualizes existing links but does not improve machine search relevance by itself.",
  },
  {
    id: "concepts/wiki-reindex",
    type: "concept",
    title: "Wiki Reindexing",
    aliases: ["wiki_reindex"],
    body: "Reindexing rescans valid Markdown, refreshes lexical state, embeds stale chunks, removes deleted pages, and keeps the last usable index if rebuilding fails.",
  },
  {
    id: "concepts/node-runtime-policy",
    type: "concept",
    title: "Node Runtime Policy",
    body: "The QMD-backed major requires Node.js 22 or newer. Users requiring Node.js 18 remain on the previous package major.",
  },
  {
    id: "concepts/conflict-preservation",
    type: "concept",
    title: "Memory Conflict Preservation",
    body: "Conflicting claims remain stored with their evidence. Recall shows both and asks the user which scope or claim applies instead of silently choosing.",
  },
  {
    id: "concepts/retrieval-feedback",
    type: "concept",
    title: "Retrieval Feedback",
    body: "Explicit corrections are strong signals. Opened, cited, and shown-only events are weaker, bounded, decaying signals and never rewrite facts.",
  },
  {
    id: "concepts/query-expansion",
    type: "concept",
    title: "Query Expansion",
    body: "Query expansion may improve broad questions but can drift. Adaptive retrieval escalates only uncertain results while exact identifiers bypass expansion.",
  },
  {
    id: "concepts/validated-index-mirror",
    type: "concept",
    title: "Validated Index Mirror",
    body: "QMD indexes a generated mirror containing only pages accepted by the shared Markdown parser, so malformed pages cannot influence candidate generation.",
  },
  {
    id: "syntheses/second-brain-retrieval",
    type: "synthesis",
    title: "Second-Brain Retrieval Architecture",
    body: "The strongest second-brain design combines QMD candidate retrieval with canonical-card prioritization, source evidence, contradiction assembly, bounded feedback, and measured evaluation.",
  },
  {
    id: "analyses/qmd-adoption-decision",
    type: "analysis",
    title: "QMD Adoption Decision",
    body: "The project chose QMD as the first-class retrieval engine rather than rebuilding BM25, vector search, RRF, and local reranking.",
  },
  {
    id: "sources/qmd-2-5-3-release",
    type: "source",
    title: "QMD 2.5.3 Release Evidence",
    body: "The published QMD 2.5.3 package requires Node.js 22, exposes a TypeScript SDK, and supports model-free searchLex plus model-backed vector and reranking calls.",
  },
  {
    id: "sources/vault-audit",
    type: "source",
    title: "Vault Retrieval Audit",
    body: "The audited vault had hundreds of source observations, few canonical concepts, almost no retrieval metadata, and no active embedding sidecar.",
  },
  {
    id: "sources/user-card-first-decision",
    type: "source",
    title: "Card-First User Decision",
    body: "The user selected canonical atomic cards first, with observations retained as evidence rather than mixed equally in recall.",
  },
  {
    id: "sources/reindex-failure-recovery",
    type: "source",
    title: "Reindex Recovery Requirement",
    body: "A failed full rebuild must preserve the previous closed database artifact and report stale derived state instead of deleting the usable index.",
  },
  {
    id: "sources/node-22-decision",
    type: "source",
    title: "Node 22 Major-Version Decision",
    body: "The user approved a clean major-version break to Node.js 22 so QMD can be a first-class dependency.",
  },
  {
    id: "sources/old-conflicting-claim",
    type: "source",
    title: "Older Conflicting Claim",
    body: "An older note says raw observations should always outrank synthesized cards because they are closer to original evidence.",
  },
  {
    id: "sources/new-conflicting-claim",
    type: "source",
    title: "Newer Conflicting Claim",
    body: "A newer reviewed decision says canonical cards should rank first while raw observations remain attached evidence.",
  },
  {
    id: "sources/feedback-evaluation",
    type: "source",
    title: "Feedback Evaluation Evidence",
    body: "Click and open behavior is position-biased, so implicit engagement must remain a tiny supplementary signal rather than factual ground truth.",
  },
];

interface QueryGroup {
  key: string;
  category: BenchmarkQuery["category"];
  split: BenchmarkSplit;
  texts: [string, string, string, string, string];
  judgments: BenchmarkJudgment[];
  autoExpectation?: AutoExpectation;
  expectedConflicts?: string[];
}

const canonical = (pageId: string, grade: 1 | 2 | 3 = 3): BenchmarkJudgment => ({
  pageId,
  grade,
  role: "canonical",
});

const evidence = (pageId: string, grade: 1 | 2 | 3 = 2): BenchmarkJudgment => ({
  pageId,
  grade,
  role: "evidence",
});

const groups: QueryGroup[] = [
  {
    key: "qmd-exact",
    category: "exact_lookup",
    split: "train",
    texts: [
      "QMD",
      "Query Markup Documents",
      "QMD Markdown search engine",
      "find the QMD note",
      "QMD BM25 vector reranker",
    ],
    judgments: [canonical("entities/qmd"), evidence("sources/qmd-2-5-3-release")],
  },
  {
    key: "qmd-entity",
    category: "entity_alias",
    split: "train",
    texts: [
      "what tool is abbreviated QMD",
      "the local document search tool",
      "which entity provides local Markdown retrieval",
      "QMD full name",
      "on-device search for Markdown notes",
    ],
    judgments: [canonical("entities/qmd"), canonical("analyses/qmd-adoption-decision", 2)],
  },
  {
    key: "hybrid-paraphrase",
    category: "paraphrase",
    split: "heldout",
    texts: [
      "combine exact words with meaning based search",
      "find notes when I remember different wording",
      "keyword plus semantic document lookup",
      "search using both literal terms and concepts",
      "mix sparse and dense retrieval",
    ],
    judgments: [canonical("concepts/hybrid-retrieval"), canonical("concepts/reciprocal-rank-fusion", 1)],
  },
  {
    key: "cards-vague",
    category: "vague_recollection",
    split: "train",
    texts: [
      "the decision about useful memory before noisy notes",
      "what should the AI remember first",
      "reviewed conclusion with proof behind it",
      "stop raw observations drowning good knowledge",
      "card first memory organization",
    ],
    judgments: [canonical("concepts/canonical-memory-cards"), evidence("sources/user-card-first-decision")],
  },
  {
    key: "zettelkasten-concept",
    category: "conceptual",
    split: "train",
    texts: [
      "what is Zettelkasten",
      "is Zettelkasten a search algorithm",
      "atomic permanent notes and meaningful links",
      "什么是卡片盒笔记法",
      "zettelkasten 是搜索算法吗",
    ],
    judgments: [canonical("concepts/zettelkasten")],
  },
  {
    key: "obsidian-graph",
    category: "graph_scope",
    split: "heldout",
    texts: [
      "does Obsidian graph improve search ranking",
      "what is graph view useful for",
      "find orphan notes visually",
      "can the Obsidian graph replace retrieval",
      "human link visualization versus machine relevance",
    ],
    judgments: [canonical("concepts/obsidian-graph-view")],
  },
  {
    key: "reindex-evidence",
    category: "evidence_request",
    split: "train",
    texts: [
      "how do I rebuild a stale wiki search index",
      "what evidence says failed reindex keeps the old database",
      "refresh lexical documents and stale vectors",
      "remove deleted notes from search",
      "wiki_reindex recovery requirement",
    ],
    judgments: [canonical("concepts/wiki-reindex"), evidence("sources/reindex-failure-recovery")],
  },
  {
    key: "node-temporal",
    category: "temporal",
    split: "train",
    texts: [
      "which Node version does the next major require",
      "can Node 18 use the QMD major",
      "current runtime decision for QMD",
      "why did the project move to Node 22",
      "published QMD package Node requirement",
    ],
    judgments: [canonical("concepts/node-runtime-policy"), evidence("sources/node-22-decision")],
  },
  {
    key: "memory-conflict",
    category: "contradiction",
    split: "heldout",
    texts: [
      "what happens when two memories disagree",
      "raw observations or canonical cards should rank first",
      "show both conflicting claims",
      "which note superseded the older ranking claim",
      "do not silently resolve contradictory memory",
    ],
    judgments: [
      canonical("concepts/conflict-preservation"),
      evidence("sources/old-conflicting-claim", 3),
      evidence("sources/new-conflicting-claim", 3),
    ],
    expectedConflicts: ["sources/old-conflicting-claim", "sources/new-conflicting-claim"],
  },
  {
    key: "feedback-conclusion",
    category: "conclusion",
    split: "train",
    texts: [
      "what did we conclude about retrieval feedback",
      "should ignored search results change facts",
      "how strong is an opened-result signal",
      "explicit correction versus implicit engagement",
      "position bias in second-brain feedback",
    ],
    judgments: [canonical("concepts/retrieval-feedback"), evidence("sources/feedback-evaluation")],
  },
  {
    key: "architecture-synthesis",
    category: "synthesis",
    split: "train",
    texts: [
      "best architecture for an AI second brain",
      "combine QMD with canonical evidence memory",
      "full retrieval design summary",
      "why QMD alone is not enough",
      "candidate search plus wiki memory semantics",
    ],
    judgments: [canonical("syntheses/second-brain-retrieval"), canonical("analyses/qmd-adoption-decision", 2)],
  },
  {
    key: "unrelated-negative",
    category: "negative",
    split: "train",
    texts: [
      "Flipkart casual mens wear",
      "Razorpay webhook endpoint",
      "hotel trial balance audit",
      "exercise deletion in an admin panel",
      "sales register round off convention",
    ],
    judgments: [],
    autoExpectation: "none",
  },
];

export const benchmarkQueries: BenchmarkQuery[] = groups.flatMap((group) =>
  group.texts.map((text, index) => ({
    id: `${group.key}-${index + 1}`,
    text,
    category: group.category,
    split: group.split,
    judgments: group.judgments.map((judgment) => ({ ...judgment })),
    autoExpectation: group.autoExpectation ?? "hit",
    expectedConflicts: group.expectedConflicts ? [...group.expectedConflicts] : undefined,
  })),
);
```

- [ ] **Step 4: Run the fixture-contract test**

Run:

```bash
pnpm exec vitest run test/retrieval-benchmark-fixture.test.ts --reporter=verbose
```

Expected: 4 tests PASS; query count is 60, split is 45/15, and no privacy pattern appears.

- [ ] **Step 5: Commit the fixture**

```bash
git add test/fixtures/retrieval-benchmark/fixture.ts test/retrieval-benchmark-fixture.test.ts
git commit -m "test: add retrieval benchmark fixture"
```

---

### Task 3: Implement deterministic retrieval metrics

**Files:**
- Create: `test/helpers/retrieval-metrics.ts`
- Create: `test/retrieval-metrics.test.ts`

- [ ] **Step 1: Write failing unit tests for ranking metrics**

Create `test/retrieval-metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BenchmarkQuery } from "./fixtures/retrieval-benchmark/fixture.js";
import {
  evaluateBenchmark,
  ndcgAt,
  reciprocalRank,
  recallAt,
  type BenchmarkRun,
} from "./helpers/retrieval-metrics.js";

const queries: BenchmarkQuery[] = [
  {
    id: "ranked",
    text: "ranked query",
    category: "contradiction",
    split: "train",
    judgments: [
      { pageId: "cards/a", grade: 3, role: "canonical" },
      { pageId: "sources/b", grade: 2, role: "evidence" },
    ],
    autoExpectation: "hit",
    expectedConflicts: ["cards/a", "sources/b"],
  },
  {
    id: "negative",
    text: "unrelated query",
    category: "negative",
    split: "heldout",
    judgments: [],
    autoExpectation: "none",
  },
];

const runs: BenchmarkRun[] = [
  { queryId: "ranked", rankedPageIds: ["sources/b", "cards/a", "other/x"], autoPageIds: ["sources/b"] },
  { queryId: "negative", rankedPageIds: ["other/x"], autoPageIds: ["other/x"] },
];

describe("retrieval metrics", () => {
  it("computes recall and reciprocal rank", () => {
    expect(recallAt(["x", "a", "b"], new Set(["a", "b"]), 2)).toBe(0.5);
    expect(reciprocalRank(["x", "a", "b"], new Set(["a", "b"]))).toBe(0.5);
  });

  it("computes graded nDCG independent of raw retrieval scores", () => {
    const grades = new Map([
      ["cards/a", 3],
      ["sources/b", 2],
    ]);
    expect(ndcgAt(["cards/a", "sources/b"], grades, 2)).toBe(1);
    expect(ndcgAt(["sources/b", "cards/a"], grades, 2)).toBeGreaterThan(0.8);
    expect(ndcgAt(["sources/b", "cards/a"], grades, 2)).toBeLessThan(1);
    expect(ndcgAt(["sources/b", "cards/a"], grades, 2)).toBeCloseTo(0.834, 3);
  });

  it("separates relevance, evidence, contradiction, and auto false-positive measures", () => {
    const report = evaluateBenchmark(queries, runs);
    expect(report.all.candidateRecall20).toBe(1);
    expect(report.all.mrr).toBe(1);
    expect(report.all.canonicalAt3).toBe(1);
    expect(report.all.evidenceRecall20).toBe(1);
    expect(report.all.contradictionCoverage).toBe(1);
    expect(report.all.autoFalsePositiveRate).toBe(1);
    expect(report.train.queryCount).toBe(1);
    expect(report.heldout.queryCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the metric test and verify the helper is missing**

Run:

```bash
pnpm exec vitest run test/retrieval-metrics.test.ts --reporter=verbose
```

Expected: FAIL with a module-resolution error for `helpers/retrieval-metrics.js`.

- [ ] **Step 3: Implement the pure metric helper**

Create `test/helpers/retrieval-metrics.ts`:

```ts
import type {
  BenchmarkJudgment,
  BenchmarkQuery,
  BenchmarkSplit,
} from "../fixtures/retrieval-benchmark/fixture.js";

export interface BenchmarkRun {
  queryId: string;
  rankedPageIds: string[];
  autoPageIds: string[];
}

export interface RetrievalMetrics {
  queryCount: number;
  judgedQueryCount: number;
  candidateRecall20: number;
  mrr: number;
  ndcg5: number;
  ndcg10: number;
  canonicalAt3: number;
  evidenceRecall20: number;
  contradictionCoverage: number;
  autoFalsePositiveRate: number;
}

export interface RetrievalMetricReport {
  all: RetrievalMetrics;
  train: RetrievalMetrics;
  heldout: RetrievalMetrics;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function recallAt(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 0;
  const found = new Set(rankedIds.slice(0, k).filter((id) => relevantIds.has(id)));
  return found.size / relevantIds.size;
}

export function reciprocalRank(rankedIds: string[], relevantIds: Set<string>): number {
  const index = rankedIds.findIndex((id) => relevantIds.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

export function ndcgAt(rankedIds: string[], gradesById: Map<string, number>, k: number): number {
  const actual = rankedIds.slice(0, k).map((id) => gradesById.get(id) ?? 0);
  const ideal = [...gradesById.values()].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg;
}

function idsForRole(judgments: BenchmarkJudgment[], role?: BenchmarkJudgment["role"]): Set<string> {
  return new Set(
    judgments
      .filter((judgment) => judgment.grade > 0 && (role === undefined || judgment.role === role))
      .map((judgment) => judgment.pageId),
  );
}

function evaluateSlice(queries: BenchmarkQuery[], runById: Map<string, BenchmarkRun>): RetrievalMetrics {
  const judged = queries.filter((query) => query.judgments.length > 0);
  const canonical = queries.filter((query) => idsForRole(query.judgments, "canonical").size > 0);
  const evidence = queries.filter((query) => idsForRole(query.judgments, "evidence").size > 0);
  const conflicts = queries.filter((query) => (query.expectedConflicts?.length ?? 0) > 0);
  const negatives = queries.filter((query) => query.autoExpectation === "none");

  const rankedFor = (query: BenchmarkQuery) => runById.get(query.id)?.rankedPageIds ?? [];
  const autoFor = (query: BenchmarkQuery) => runById.get(query.id)?.autoPageIds ?? [];

  return {
    queryCount: queries.length,
    judgedQueryCount: judged.length,
    candidateRecall20: round(
      mean(judged.map((query) => recallAt(rankedFor(query), idsForRole(query.judgments), 20))),
    ),
    mrr: round(
      mean(judged.map((query) => reciprocalRank(rankedFor(query), idsForRole(query.judgments)))),
    ),
    ndcg5: round(
      mean(
        judged.map((query) =>
          ndcgAt(
            rankedFor(query),
            new Map(query.judgments.map((judgment) => [judgment.pageId, judgment.grade])),
            5,
          ),
        ),
      ),
    ),
    ndcg10: round(
      mean(
        judged.map((query) =>
          ndcgAt(
            rankedFor(query),
            new Map(query.judgments.map((judgment) => [judgment.pageId, judgment.grade])),
            10,
          ),
        ),
      ),
    ),
    canonicalAt3: round(
      mean(
        canonical.map((query) => {
          const relevant = idsForRole(query.judgments, "canonical");
          return rankedFor(query).slice(0, 3).some((id) => relevant.has(id)) ? 1 : 0;
        }),
      ),
    ),
    evidenceRecall20: round(
      mean(
        evidence.map((query) => recallAt(rankedFor(query), idsForRole(query.judgments, "evidence"), 20)),
      ),
    ),
    contradictionCoverage: round(
      mean(
        conflicts.map((query) => {
          const found = new Set(rankedFor(query).slice(0, 20));
          return query.expectedConflicts!.every((id) => found.has(id)) ? 1 : 0;
        }),
      ),
    ),
    autoFalsePositiveRate: round(
      mean(negatives.map((query) => (autoFor(query).length > 0 ? 1 : 0))),
    ),
  };
}

export function evaluateBenchmark(
  queries: BenchmarkQuery[],
  runs: BenchmarkRun[],
): RetrievalMetricReport {
  const runById = new Map(runs.map((run) => [run.queryId, run]));
  const bySplit = (split: BenchmarkSplit) => queries.filter((query) => query.split === split);
  return {
    all: evaluateSlice(queries, runById),
    train: evaluateSlice(bySplit("train"), runById),
    heldout: evaluateSlice(bySplit("heldout"), runById),
  };
}
```

- [ ] **Step 4: Run fixture and metric tests**

Run:

```bash
pnpm exec vitest run test/retrieval-benchmark-fixture.test.ts test/retrieval-metrics.test.ts --reporter=verbose
```

Expected: 7 tests PASS.

- [ ] **Step 5: Commit the metric engine**

```bash
git add test/helpers/retrieval-metrics.ts test/retrieval-metrics.test.ts
git commit -m "test: add retrieval quality metrics"
```

---

### Task 4: Record the current heuristic recall baseline

**Files:**
- Create: `test/retrieval-benchmark.test.ts`
- Create: `scripts/update-retrieval-baseline.mjs`
- Create: `docs/superpowers/benchmarks/phase-1-current-baseline.json` (generated)
- Modify: `package.json`

- [ ] **Step 1: Create the benchmark runner test**

Create `test/retrieval-benchmark.test.ts`:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import {
  BENCHMARK_VERSION,
  benchmarkPages,
  benchmarkQueries,
  type BenchmarkPage,
} from "./fixtures/retrieval-benchmark/fixture.js";
import { rootDir } from "./helpers.js";
import { evaluateBenchmark, type BenchmarkRun } from "./helpers/retrieval-metrics.js";

const baselinePath = join(
  rootDir,
  "docs",
  "superpowers",
  "benchmarks",
  "phase-1-current-baseline.json",
);
const tempRoot = mkdtempSync(join(tmpdir(), "pi-llm-wiki-retrieval-"));

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function renderPage(page: BenchmarkPage): string {
  const metadata = [
    "---",
    `type: ${page.type}`,
    `title: ${JSON.stringify(page.title)}`,
    `status: ${page.status ?? "stable"}`,
    ...(page.aliases ? [`aliases: ${JSON.stringify(page.aliases)}`] : []),
    ...(page.tags ? [`tags: ${JSON.stringify(page.tags)}`] : []),
    "---",
    "",
  ];
  return `${metadata.join("\n")}${page.body}\n`;
}

function createBenchmarkVault(): ReturnType<typeof getVaultPaths> {
  const paths = getVaultPaths(tempRoot);
  ensureVaultStructure(paths);
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    `${JSON.stringify({ name: "Retrieval Benchmark", knowledge_format: "legacy" }, null, 2)}\n`,
  );
  for (const page of benchmarkPages) {
    const path = join(paths.wiki, `${page.id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPage(page));
  }
  const rebuilt = rebuildMetadata(paths);
  expect(rebuilt.ok, JSON.stringify(rebuilt.diagnostics, null, 2)).toBe(true);
  return paths;
}

function currentPackageContract(): { node: string; qmd: string } {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
  };
  return { node: pkg.engines.node, qmd: pkg.dependencies["@tobilu/qmd"] };
}

describe("current heuristic retrieval benchmark", () => {
  it("matches the committed deterministic Phase 1 baseline", () => {
    const paths = createBenchmarkVault();
    const runs: BenchmarkRun[] = benchmarkQueries.map((query) => ({
      queryId: query.id,
      rankedPageIds: searchWiki(paths, query.text, 20, 0).map((result) => result.id),
      autoPageIds: searchWiki(paths, query.text, 3, 5).map((result) => result.id),
    }));
    const report = {
      schema: 1,
      fixtureVersion: BENCHMARK_VERSION,
      engine: "current-heuristic",
      productionRecallChanged: false,
      packageContract: currentPackageContract(),
      queryCounts: {
        all: benchmarkQueries.length,
        train: benchmarkQueries.filter((query) => query.split === "train").length,
        heldout: benchmarkQueries.filter((query) => query.split === "heldout").length,
      },
      metrics: evaluateBenchmark(benchmarkQueries, runs),
    };

    if (process.env.UPDATE_RETRIEVAL_BASELINE === "1") {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    }

    expect(existsSync(baselinePath), `Run pnpm benchmark:retrieval:update to create ${baselinePath}`).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual(report);
  });
});
```

- [ ] **Step 2: Run the benchmark test and verify the baseline is missing**

Run:

```bash
pnpm exec vitest run test/retrieval-benchmark.test.ts --reporter=verbose
```

Expected: FAIL with `Run pnpm benchmark:retrieval:update` because the committed baseline does not exist yet.

- [ ] **Step 3: Add the cross-platform baseline update script**

Create `scripts/update-retrieval-baseline.mjs`:

```js
#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitest, "run", "test/retrieval-benchmark.test.ts", "--reporter=verbose"],
  {
    cwd: root,
    env: { ...process.env, UPDATE_RETRIEVAL_BASELINE: "1" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
```

- [ ] **Step 4: Add benchmark scripts to `package.json`**

Add these entries to the existing `scripts` object:

```json
"benchmark:retrieval": "vitest run test/retrieval-benchmark.test.ts --reporter=verbose",
"benchmark:retrieval:update": "node scripts/update-retrieval-baseline.mjs"
```

- [ ] **Step 5: Generate and inspect the deterministic baseline artifact**

Run:

```bash
pnpm benchmark:retrieval:update
pnpm benchmark:retrieval
```

Expected: both commands PASS and create `docs/superpowers/benchmarks/phase-1-current-baseline.json` with schema 1, 60/45/15 query counts, QMD contract `2.5.3`, and separate all/train/heldout metrics. Do not hand-edit metric values.

- [ ] **Step 6: Prove the baseline is reproducible**

Run:

```bash
node -e "const f=require('node:fs').readFileSync('docs/superpowers/benchmarks/phase-1-current-baseline.json');const c=require('node:crypto').createHash('sha256').update(f).digest('hex');console.log(c)"
pnpm benchmark:retrieval:update
node -e "const f=require('node:fs').readFileSync('docs/superpowers/benchmarks/phase-1-current-baseline.json');const c=require('node:crypto').createHash('sha256').update(f).digest('hex');console.log(c)"
```

Expected: both hashes are identical.

- [ ] **Step 7: Run all benchmark unit tests**

Run:

```bash
pnpm exec vitest run test/retrieval-benchmark-fixture.test.ts test/retrieval-metrics.test.ts test/retrieval-benchmark.test.ts --reporter=verbose
```

Expected: 8 tests PASS.

- [ ] **Step 8: Commit the baseline harness and artifact**

```bash
git add package.json scripts/update-retrieval-baseline.mjs test/retrieval-benchmark.test.ts docs/superpowers/benchmarks/phase-1-current-baseline.json
git commit -m "test: record current retrieval baseline"
```

---

### Task 5: Contract-test QMD's public SDK without activating it

**Files:**
- Create: `test/qmd-contract.test.ts`

- [ ] **Step 1: Create exact compile-time mode contracts and model-free runtime smoke**

Create `test/qmd-contract.test.ts`:

```ts
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createStore,
  type ExpandedQuery,
  type QMDStore,
  type SearchOptions,
} from "@tobilu/qmd";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hybridQueries: ExpandedQuery[] = [
  { type: "lex", query: "signed access tokens" },
  { type: "vec", query: "how users authenticate" },
];

const modeContracts = {
  hybrid: {
    queries: hybridQueries,
    rerank: false,
    candidateLimit: 40,
    limit: 10,
    explain: true,
  },
  adaptiveUncertain: {
    query: "how users authenticate",
    intent: "Authentication documentation",
    rerank: true,
    candidateLimit: 40,
    limit: 10,
    explain: true,
  },
  quality: {
    query: "how users authenticate",
    intent: "Authentication documentation",
    rerank: true,
    candidateLimit: 40,
    limit: 10,
    explain: true,
  },
} satisfies Record<string, SearchOptions>;

const tempRoot = mkdtempSync(join(tmpdir(), "pi-llm-wiki-qmd-contract-"));
const docsPath = join(tempRoot, "docs");
const dbPath = join(tempRoot, "index.sqlite");
let store: QMDStore;

function modelFiles(): string[] {
  const modelDir = join(homedir(), ".cache", "qmd", "models");
  if (!existsSync(modelDir)) return [];
  return readdirSync(modelDir).sort();
}

beforeAll(async () => {
  mkdirSync(docsPath, { recursive: true });
  writeFileSync(join(docsPath, "auth.md"), "# Authentication\n\nUsers authenticate with signed access tokens.\n");
  writeFileSync(join(docsPath, "cache.md"), "# Cache\n\nCache entries expire after five minutes.\n");
  store = await createStore({
    dbPath,
    config: {
      global_context: "SDK compatibility fixture",
      collections: {
        docs: { path: docsPath, pattern: "**/*.md" },
      },
    },
  });
});

afterAll(async () => {
  await store?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("QMD 2.5.3 SDK contract", () => {
  it("keeps the four-mode request shapes type-compatible", () => {
    expect(modeContracts.hybrid.queries).toEqual(hybridQueries);
    expect(modeContracts.adaptiveUncertain.rerank).toBe(true);
    expect(modeContracts.quality.candidateLimit).toBe(40);
  });

  it("updates and performs lexical search without downloading a model", async () => {
    const beforeModels = modelFiles();
    const updated = await store.update();
    expect(updated.collections).toBe(1);
    expect(updated.indexed).toBe(2);
    expect(updated.needsEmbedding).toBe(2);

    const results = await store.searchLex("signed access tokens", { collection: "docs", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("fts");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].title).toContain("Authentication");

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(2);
    expect(status.needsEmbedding).toBe(2);
    expect(modelFiles()).toEqual(beforeModels);
  });

  it.runIf(process.env.QMD_MODEL_SMOKE === "1")(
    "embeds, performs vector/hybrid search, expands, and reranks",
    async () => {
      const embedded = await store.embed({ force: true, chunkStrategy: "regex" });
      expect(embedded.docsProcessed).toBe(2);
      expect(embedded.errors).toBe(0);

      const vector = await store.searchVector("how users log in", { collection: "docs", limit: 5 });
      expect(vector.length).toBeGreaterThan(0);

      const hybrid = await store.search({ ...modeContracts.hybrid, collections: ["docs"] });
      expect(hybrid.length).toBeGreaterThan(0);

      const expanded = await store.expandQuery("how users authenticate", {
        intent: "Authentication documentation",
      });
      expect(expanded.length).toBeGreaterThan(0);

      const quality = await store.search({ ...modeContracts.quality, collections: ["docs"] });
      expect(quality.length).toBeGreaterThan(0);
      expect(quality[0].score).toBeGreaterThan(0);
    },
    1_200_000,
  );
});
```

- [ ] **Step 2: Run the ordinary contract test**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose
```

Windows PowerShell equivalent: `$env:QMD_FORCE_CPU='1'; pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose`

Expected: mode-shape and lexical tests PASS; model-backed test is skipped; no QMD model file is created.

- [ ] **Step 3: Run the full typecheck against QMD's exported declarations**

Run:

```bash
pnpm typecheck
```

Expected: PASS. A missing or changed QMD method/type fails here before Phase 2 planning.

- [ ] **Step 4: Commit the SDK contract**

```bash
git add test/qmd-contract.test.ts
git commit -m "test: lock QMD SDK compatibility"
```

---

### Task 6: Add platform CI, model smoke, and operator documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/qmd-model-smoke.yml`
- Create: `docs/retrieval-benchmark.md`
- Create: `docs/qmd-compatibility.md`

- [ ] **Step 1: Restrict the normal quality matrix to supported Node.js LTS versions**

In `.github/workflows/ci.yml`, replace:

```yaml
node-version: [20, 22, 23, 24, 25]
```

with:

```yaml
node-version: [22, 24]
```

Keep the standalone Node 18 migration-script job: it executes the shipped migration file directly and does not claim the new extension runtime supports Node 18.

- [ ] **Step 2: Add cross-platform native-install and lexical contract coverage to `ci.yml`**

Add this job after `quality` and before `migration-node18`:

```yaml
  qmd-native-compatibility:
    name: QMD native compatibility (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-15, windows-latest]
    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
        env:
          PUPPETEER_SKIP_DOWNLOAD: true

      - name: Verify QMD SDK and model-free lexical search
        run: pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose
        env:
          QMD_FORCE_CPU: "1"
```

Expected: the same package and lexical SDK test runs against native SQLite dependencies on Linux x64, macOS arm64, and Windows x64.

- [ ] **Step 3: Create the opt-in and scheduled model-backed workflow**

Create `.github/workflows/qmd-model-smoke.yml`:

```yaml
name: QMD Model Smoke

on:
  workflow_dispatch:
  schedule:
    - cron: "0 4 * * 1"

concurrency:
  group: qmd-model-smoke
  cancel-in-progress: true

jobs:
  model-smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
        env:
          PUPPETEER_SKIP_DOWNLOAD: true

      - name: Cache QMD models
        uses: actions/cache@v4
        with:
          path: ~/.cache/qmd/models
          key: qmd-2.5.3-models-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Exercise embedding, vector, expansion, fusion, and reranking
        run: pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose
        env:
          QMD_FORCE_CPU: "1"
          QMD_MODEL_SMOKE: "1"
```

- [ ] **Step 4: Document the benchmark contract and commands**

Create `docs/retrieval-benchmark.md`:

```markdown
# Retrieval Benchmark

The Phase 1 benchmark records current heuristic recall quality before QMD powers production retrieval.

## Corpus

`test/fixtures/retrieval-benchmark/fixture.ts` contains 22 sanitized Markdown pages and 60 graded queries:

- 45 train queries
- 15 immutable held-out queries
- exact lookup, aliases, paraphrase, vague recollection, concepts, graph scope, evidence, time, conflicts, conclusions, synthesis, and unrelated negatives
- English, Chinese, and mixed-language examples

The fixture must not contain raw home paths, email addresses, credentials, customer identifiers, or copied private notes. Sanitize representative phrasing before committing it.

The CJK query `什么是卡片盒笔记法` (zettelkasten-concept #4) is an intentional guaranteed miss for the current heuristic engine: the page body is English-only, so lexical score is zero by construction. Do not reword the page to make it pass; it exists to prove that only CJK-aware lexical handling (QMD's normalized FTS) can recover it.

## Judgments

Grades are:

- `3`: directly answers the query
- `2`: useful supporting evidence or secondary answer
- `1`: relevant context

Roles are `canonical` or `evidence`. Contradiction queries list every claim that must appear together.

## Metrics

The report records candidate Recall@20, MRR, nDCG@5, nDCG@10, canonical@3, evidence Recall@20, contradiction coverage, and automatic-recall false-positive rate. Scores are computed from ranked page IDs, never raw engine scores.

## Commands

Verify the committed baseline:

```bash
pnpm benchmark:retrieval
```

Regenerate after an intentional fixture or baseline-engine change:

```bash
pnpm benchmark:retrieval:update
pnpm benchmark:retrieval
```

Never hand-edit `docs/superpowers/benchmarks/phase-1-current-baseline.json`. Every update must explain why the benchmark or baseline engine changed. Later phases may tune against `train`, but must not inspect or alter held-out judgments while tuning.
```

- [ ] **Step 5: Document the pinned QMD compatibility contract**

Create `docs/qmd-compatibility.md`:

```markdown
# QMD Compatibility

pi-llm-wiki's next major pins `@tobilu/qmd` **2.5.3**, the latest version published to npm when Phase 1 was planned.

## Runtime

- Node.js: `>=22.0.0`
- TypeScript development peer: `^5.9.3`
- Package manager: pnpm 9

Users requiring Node.js 18 must remain on the previous pi-llm-wiki major.

## Native compatibility

Clean-install CI covers:

- Linux x64
- macOS arm64
- Windows x64

QMD brings `better-sqlite3`, `sqlite-vec`, and `node-llama-cpp`. Failure to install required native packages is an installation failure, not a runtime lexical fallback.

## Model-free contract

`createStore`, `update`, `searchLex`, `getStatus`, and `close` must work without downloading or loading an embedding, expansion, or reranking model. Ordinary CI tests this path with `QMD_FORCE_CPU=1`.

## Model-backed contract

The scheduled/manual model smoke exercises:

- `embed`
- `searchVector`
- typed hybrid `search` with reranking disabled
- `expandQuery`
- expanded/reranked `search`

QMD stores default models under `~/.cache/qmd/models`. First use downloads roughly 2 GB across embedding, reranking, and expansion models. CI caches that directory. `QMD_FORCE_CPU=1` avoids GPU probing in compatibility jobs.

## Upgrade rule

Do not widen the QMD version range. A QMD upgrade requires:

1. exact-version lock update
2. SDK contract and clean-install CI passing
3. model smoke passing
4. retrieval benchmark comparison before production use
5. updated model and native-support documentation
```

- [ ] **Step 6: Run all Phase 1 checks**

Run:

```bash
pnpm benchmark:retrieval
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
pnpm test
pnpm build:mcp
```

Expected: all commands exit 0; QMD model-backed smoke remains skipped locally unless explicitly enabled.

- [ ] **Step 7: Verify active recall code did not change**

Run:

```bash
git diff 42d6fd1 -- extensions/llm-wiki/lib/recall.ts extensions/llm-wiki/index.ts mcp/operations.ts
```

Expected: no diff. Phase 1 must not alter production recall or indexing behavior.

- [ ] **Step 8: Commit CI and documentation**

```bash
git add .github/workflows/ci.yml .github/workflows/qmd-model-smoke.yml docs/retrieval-benchmark.md docs/qmd-compatibility.md
git commit -m "ci: verify QMD compatibility"
```

- [ ] **Step 9: Confirm a clean phase boundary**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: clean working tree and six Phase 1 commits after the planning commits. Active recall remains current heuristic retrieval; Phase 2 may now plan validated per-vault QMD indexing.
