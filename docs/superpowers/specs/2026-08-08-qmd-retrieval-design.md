# QMD-Backed Second-Brain Retrieval Design

**Status:** Approved design  
**Target:** Next major release  
**Runtime:** Node.js 22 or newer  
**Date:** 2026-08-08

## Summary

pi-llm-wiki will replace its heuristic recall ranking with QMD as its first-class retrieval engine. QMD will own Markdown indexing, BM25 retrieval, dense retrieval, rank fusion, query expansion, and local reranking. pi-llm-wiki will continue to own the knowledge model: canonical-card prioritization, evidence and contradiction assembly, feedback, context packing, layered vault behavior, and quality evaluation.

Markdown remains authoritative. QMD's SQLite database and model artifacts are local, rebuildable implementation details. No custom database or graph database will be introduced.

The product goal is not to return pages that merely resemble a query. Recall must provide useful memory for an AI: the best reviewed conclusion first, its strongest evidence, applicable scope and freshness, and any relevant competing claim.

## Current-State Audit

The personal vault inspected during design contained:

- 701 registered pages
- 626 `source` pages
- 40 `concept` pages
- 26 `entity` pages
- 9 generic pages
- titles and types on every registered page
- tags on 63% of pages
- effectively no summaries, descriptions, aliases, recall triggers, or domain metadata
- no `meta/embeddings.json`, so live recall was lexical-only

Current recall performs weighted substring matching over metadata and heading chunks, heuristic pseudo-relevance feedback, optional page-level embedding boosts, and raw additive score fusion. Its tests establish deterministic mechanics but do not measure relevance on real queries.

The live recall examples observed during brainstorming returned unrelated accounting, webhook, shopping, and build notes for questions about retrieval architecture. This is unacceptable for automatic AI context injection.

## Goals

1. Make recall precise and useful enough to improve downstream AI work.
2. Return reviewed canonical knowledge before raw observations whenever possible.
3. Preserve source evidence, provenance, scope, freshness, and conflicting claims.
4. Support exact lookup, paraphrase, vague recollection, temporal questions, contradiction discovery, and synthesis.
5. Provide lexical, hybrid, adaptive, and maximum-quality retrieval modes.
6. Reindex incrementally during ordinary writes and fully on explicit request.
7. Learn conservatively from explicit corrections and local usage signals.
8. Measure retrieval quality against a versioned benchmark built from real queries.
9. Keep Markdown portable and Obsidian-compatible.
10. Fail toward no recall or a cheaper retrieval mode, never toward unrelated injected memory.

## Non-Goals

- A custom vector database
- A graph database
- Graph-first or agentic traversal as the primary retriever
- Automatic conversion of every observation into a canonical card
- Automatic deletion or silent replacement of conflicting claims
- Training a personalized ranking model from a small feedback corpus
- Supporting Node.js 18 in the new major release
- Maintaining two independent full retrieval engines
- Treating Obsidian Graph View as a ranking algorithm

## Decisions and Alternatives

### Rejected: tune the existing scorer

Adding metadata, enabling page embeddings, and adjusting weights would be the smallest change, but it would preserve the weakest parts of the current system: broad page representations, incomparable score addition, heuristic query drift, and no strong reranker.

### Rejected: graph-first retrieval

A Zettelkasten graph improves human thinking and navigation, but graph traversal cannot reliably find a seed note from an arbitrary query. The current graph is also dominated by source observations. Typed links will support bounded evidence assembly after retrieval, not replace retrieval.

### Selected: QMD retrieval plus pi-llm-wiki memory semantics

QMD already supplies the retrieval machinery this project would otherwise need to build and maintain:

- BM25 full-text retrieval
- dense retrieval over chunks
- reciprocal-rank fusion
- query expansion
- local reranking
- incremental indexing and embedding
- a typed TypeScript SDK

pi-llm-wiki will use QMD as a library rather than copy its implementation. The next major release will require Node.js 22 or newer and include QMD as a runtime dependency. Users who need Node.js 18 can remain on the previous major release.

## Zettelkasten Role

Zettelkasten is the knowledge organization model, not the search engine.

Its useful principles are:

- one durable idea per permanent note at a useful retrieval granularity
- source or literature notes retained as evidence
- explicit links that communicate meaningful relationships
- structure notes and backlinks that support browsing and synthesis

In pi-llm-wiki, existing `concept`, `entity`, `analysis`, `synthesis`, `skill`, and similar pages can act as permanent cards. Existing `source` and observation pages act as evidence. QMD finds candidates; Zettelkasten structure makes those candidates useful and composable.

Obsidian Graph View remains a human curation surface for finding orphans, clusters, and missing links. It visualizes existing links and tags but does not affect query relevance by itself.

## Architecture

```text
Markdown vaults
  ├── canonical knowledge pages
  ├── source and observation evidence
  └── typed Markdown relationships
          │
          ▼
QMD stores, one per vault
  ├── filesystem index
  ├── BM25 index
  ├── heading-aware chunks
  ├── embeddings
  └── local reranker
          │
          ▼
pi-llm-wiki recall service
  ├── layered vault merge
  ├── canonical/evidence classification
  ├── trust, scope, and freshness adjustments
  ├── feedback adjustments
  ├── evidence and contradiction expansion
  └── diverse token-budgeted context packing
          │
          ▼
Pi tool, MCP, and automatic recall adapters
```

### Ownership

- `.llm-wiki/wiki/**/*.md` remains authoritative, user-editable knowledge.
- `.llm-wiki/raw/**` remains immutable source material.
- `.llm-wiki/meta/qmd/**` is generated, extension-owned, and rebuildable. It contains the validated document mirror, path manifest, and complete QMD database artifacts.
- QMD model files remain in QMD's standard local cache.
- Recall feedback uses the existing authoritative `.llm-wiki/meta/events.jsonl` stream. `recall_feedback` events have `visibility: internal`, so generated human-readable logs omit them.
- `.llm-wiki/meta/recall-feedback.json` is a rebuildable aggregate projection of valid internal feedback events.

The existing guardrails for `meta/**` apply. Only extension code may modify QMD artifacts, feedback events, or projections. Full-vault backups retain feedback through `events.jsonl`; OKF-only exports exclude it, matching existing event-stream behavior. The implementation must update `docs/architecture.md` and the OKF ownership documentation to describe internal events and the feedback projection.

Feedback appends go through the existing `appendEvent` service as one append operation. This release upgrades that service to serialize writers with a per-vault in-process queue plus an extension-owned `meta/events.lock` acquired by exclusive file creation. The lock records writer ID and acquisition time; a writer may recover a lock older than 30 seconds only after confirming the recorded local process no longer exists. Implicit events wait at most 250 ms and may be dropped with a diagnostic; explicit corrections and conflict choices wait up to 2 seconds and return an error without mutating knowledge if the lock remains busy. Replay ignores events for deleted pages. There is no automatic retention or compaction in this release. If the event source is unreadable or malformed, feedback adjustments are disabled, lint reports the corruption, and the last generated projection is preserved rather than guessed or rewritten.

### One store per vault

Each personal or project vault gets an independent QMD store under its own `meta/qmd/` directory. This prevents a project index from copying personal content and keeps index invalidation local to the vault that changed.

Automatic recall searches only the active project vault when one exists, matching the current contamination guard. Outside a project vault, it searches the personal vault. Explicit `wiki_recall` searches both applicable vaults in parallel, deduplicates by page ID with project precedence, and combines the ranked lists using rank-based fusion rather than assuming raw scores are comparable across stores.

Every vault has a stable UUID in `.llm-wiki/config.json` (`vault_id`). Bootstrap creates it; first QMD indexing backfills it once for existing vaults while preserving all other configuration. Feedback and layered result identities use `(vault_id, page_id)`, so identical personal and project page IDs never share signals.

### Validated QMD mirror and collections

QMD must never scan authoritative `wiki/**` directly. Before `store.update`, pi-llm-wiki parses changed pages through the shared `KnowledgeDocument` layer and writes only valid documents into a generated mirror:

```text
meta/qmd/documents/
├── canonical/<folder-qualified-id>.md
└── evidence/<folder-qualified-id>.md
```

`meta/qmd/manifest.json` maps each mirror path to its original absolute path, vault ID, page ID, content hash, and role. Malformed pages and reserved generated `index.md`/`log.md` files have no mirror entry, so they cannot influence QMD candidate generation, expansion, or reranking. Removing or invalidating an authoritative page removes its mirror copy before the next QMD update.

The store defines two non-overlapping filesystem collections through QMD's supported `path` plus `pattern` configuration:

```ts
collections: {
  canonical: { path: "<meta>/qmd/documents/canonical", pattern: "**/*.md" },
  evidence: { path: "<meta>/qmd/documents/evidence", pattern: "**/*.md" },
}
```

Unknown page types default to the evidence mirror. Collection context tells QMD that canonical pages contain reusable conclusions while evidence pages contain provenance and historical observations. Every QMD result is mapped back through the manifest and parsed metadata before it enters memory assembly.

### Shared service boundary

A shared retrieval service owns all behavior. Pi tools, automatic injection, and MCP call the same service and only render its structured result.

Conceptual interfaces:

```ts
type RetrievalMode = "lexical" | "hybrid" | "adaptive" | "quality";
type ConflictRelation = "supersedes" | "qualifies" | "applies_under";

type ConflictResolution = {
  id: string;
  vaultId: string;
  selectedPageId: string;
  otherPageId: string;
  relation: ConflictRelation;
  scope?: string;
  status: "active";
  decidedBy: "user";
  decidedAt: string;
  replaces?: string;
};

type MemoryCandidate = {
  vault: "project" | "personal";
  vaultId: string;
  pageId: string;
  path: string;
  heading?: string;
  excerpt: string;
  qmdRank: number;
  qmdScore?: number;
  score: number;
  role: "canonical" | "evidence";
  status: "draft" | "stable" | "deprecated";
  matchReasons: string[];
};

type MemoryBundle = {
  card?: MemoryCandidate;
  evidence: MemoryCandidate[];
  conflicts: MemoryCandidate[];
  resolution?: ConflictResolution;
};
```

QMD-specific objects must not escape the QMD adapter. This keeps memory semantics testable without loading local models.

## Knowledge Model

### Card role

“Card” is a retrieval role, not a new required page type.

Canonical candidates include:

- `concept`
- `entity`
- `analysis`
- `synthesis`
- `requirement`
- `skill`
- `case`

Evidence candidates include:

- `source`
- observation pages
- `trajectory`
- unknown or generic pages unless explicitly promoted

Within canonical candidates, `status: stable` and current verification receive bounded preference. Draft pages remain retrievable but are labeled. Deprecated and stale pages remain retrievable when relevant and carry warnings.

### Atomic canonical pages

A canonical page should express one independently useful idea, claim, entity, requirement, or reusable procedure. Atomicity is measured by retrieval usefulness, not sentence count. The system must not split a coherent idea into artificial fragments merely to create more cards.

Recommended body sections are:

```md
## Claim

## Scope

## Evidence

## Related
```

The existing OKF-compatible metadata remains authoritative for type, title, description, sources, generation, verification, status, and staleness. pi-llm-wiki defines `relations` as an optional profile extension:

```yaml
relations:
  - target: concepts/other-card
    type: contradicts
```

Each relation is a mapping with exactly `target`, `type`, and optional `scope`. `target` is a normalized folder-qualified page ID without a heading or block fragment. `scope` is required for `applies_under` and forbidden for the other first-release types. Allowed types are:

- `supports`
- `contradicts`
- `qualifies`
- `supersedes`
- `applies_under`
- `derived_from`
- `related_to`

The shared parser preserves the extension, validator checks its shape, serializer round-trips it, lint resolves each target and reports duplicates, self-links, missing targets, invalid scope use, and unknown relation types. Unknown imported relation types are preserved but inert. The generated relation adjacency map deduplicates equivalent edges.

A typed relation must also have an ordinary Markdown link to the same page in the body. The Markdown link keeps Obsidian and plain OKF consumers navigable; `relations` supplies machine-readable semantics. If the body link is absent, lint reports `relation_missing_body_link` and the relation does not participate in expansion. Heading and Obsidian block anchors belong on the body link; relationship identity remains page-level. Backlinks derive one page edge from the Markdown link and attach the validated relation type without creating a duplicate edge.

Only `supports`, `contradicts`, `qualifies`, `supersedes`, `applies_under`, and `derived_from` affect evidence or conflict expansion. `related_to` remains a browsing link and receives no automatic inclusion privilege. Active user resolution records take precedence when a declared relation and a later resolution disagree, while both remain visible for audit.

### Unpromoted evidence

When no canonical card exists, recall may return the strongest source excerpt as **unpromoted evidence**. It must not be presented as an established conclusion. Promotion automation is outside this design; usage and corrections may inform a separately specified future workflow.

## Indexing and Reindexing

### Normal write path

After a successful metadata rebuild, the indexing coordinator parses changed Markdown pages and atomically updates their validated mirror copies and manifest entries. It then calls QMD's incremental update against the mirror. Stale embeddings are generated in the background. A write remains successful even if mirror or QMD indexing fails; the last valid QMD index stays available and status reports the authoritative page hash that has not yet been indexed. A malformed page never receives or retains a mirror copy for its invalid content.

### Explicit tool

The next major release adds one consolidated tool:

```text
wiki_reindex(
  scope: "changed" | "all" = "changed",
  components: ["lexical", "vectors"] = ["lexical", "vectors"],
  force: boolean = false,
  vault: "active" | "personal" | "project" | "all" = "active"
)
```

Semantics:

- `changed` scans files and updates added, changed, and removed documents.
- `all` scans the entire selected vault but still skips fresh vectors unless `force` is true.
- selecting only `lexical` never loads embedding or reranking models.
- selecting `vectors` first performs the document update required to identify stale chunks.
- `force` applies only to selected components.
- `all` vault scope processes stores independently and reports each outcome.

The tool reports:

- collections scanned
- pages indexed, updated, unchanged, and removed
- chunks needing embeddings
- vectors generated or skipped
- index and model versions
- elapsed time
- structured warnings and errors

The existing `wiki_reindex_embeddings` tool is deprecated in the new major and delegates to `wiki_reindex(components=["vectors"])` for one release before removal.

### Index lifecycle

QMD owns its SQLite schema and transactions. pi-llm-wiki does not manipulate QMD tables directly. Generated state lives as a complete artifact directory:

```text
meta/qmd/
├── current/          # index.sqlite plus any WAL/SHM/native sidecars
├── documents/        # validated mirror
├── manifest.json
└── swap.json         # present only during recoverable replacement
```

A forced rebuild uses QMD-supported replacement if the pinned SDK provides it. Otherwise it builds `staging-<uuid>/`, closes both QMD stores, checkpoints through QMD when supported, validates status and document counts, and swaps the complete directory rather than a lone SQLite file. The adapter records the swap phase in `swap.json`, renames `current` to `previous`, renames staging to `current`, reopens and validates it, then removes `previous`. Startup recovery completes or rolls back any interrupted phase. A failed reopen restores `previous`. No rename occurs while either store is open.

Content hashes, QMD schema/version information, and resolved model identities determine staleness. A removed Markdown page must disappear from QMD results after the next incremental update. Historical feedback may retain its page ID but cannot boost a result that no longer exists.

## Retrieval Modes

Configuration adds one primary setting:

```json
{
  "llm-wiki": {
    "retrievalMode": "adaptive"
  }
}
```

Invalid explicit values fail closed with a configuration diagnostic. Default is `adaptive`.

### QMD adapter mapping

| Mode | Exact QMD SDK path | Model-failure fallback |
|---|---|---|
| `lexical` | `store.searchLex(query, { limit: 40 })` | no lower mode; return diagnostic on native/store failure |
| `hybrid` | `store.search({ queries: [{ type: "lex", query }, { type: "vec", query }], rerank: false, candidateLimit: 40, limit: 10, explain: true })` | `searchLex` |
| `adaptive` initial | same typed-query call as `hybrid` | `searchLex` |
| `adaptive` uncertain | `store.search({ query, intent, rerank: true, candidateLimit: 40, limit: 10, explain: true })` | retain initial hybrid list |
| `quality` | same expanded/reranked call as adaptive-uncertain | typed hybrid, then lexical |

A typed `queries` call is mandatory for hybrid mode because plain `search({ query })` performs QMD query expansion. The adapter verifies these mappings against the pinned QMD SDK in contract tests.

### `lexical`

QMD BM25 only; no embedding, expansion, or reranking model is loaded. This mode is best for exact names, commands, identifiers, filenames, and low-resource systems.

### `hybrid`

The original query is sent as explicit lexical and vector subqueries. QMD performs rank fusion without generative expansion or final reranking.

### `adaptive`

Adaptive starts with the exact hybrid call. It invokes QMD's expanded and reranked path when any initial condition is true:

- normalized top-two score margin is below `0.08`
- Jaccard overlap between lexical and vector top-five page IDs is below `0.40`
- the normalized query begins with `who`, `what`, `when`, `where`, `why`, `how`, `which`, `compare`, `explain`, or their benchmarked multilingual equivalents
- the initial candidates contain a validated contradiction edge

An exact title, alias, command, filename, or page-ID match with normalized score at least `0.80` bypasses reranking.

### `quality`

Quality always uses QMD query expansion, lexical and vector retrieval, rank fusion, and local reranking of at most 40 candidates.

### Score normalization and first-release limits

QMD raw scores are used for within-store confidence only. Cross-vault merging converts each store's ordered results to reciprocal-rank score `1 / (60 + rank)`. The final bounded multiplier is clamped to `0.90–1.10`: exact identity match `+0.05`, stable canonical role `+0.03`, evidence role `-0.02`, deprecated status `-0.08`, and all implicit feedback combined at no more than `±0.02`. Ties resolve by lower QMD rank, then project vault, then page ID. These constants are changed only through benchmarked code changes.

Automatic recall requests at most 10 QMD candidates per vault, requires normalized QMD score `>= 0.50`, emits at most 3 memory bundles, and uses an 8,000-character context budget. Explicit recall uses caller `max_results` (default 5, maximum 10), a `0.25` QMD floor, and existing links-first rendering above the vault threshold.

Each automatic bundle contains at most one canonical page and two evidence excerpts of at most 800 characters each. Parent-page deduplication is mandatory. If alternatives exist, no more than two canonical cards with the same `(type, domain)` pair may occupy the three automatic slots. Evidence order is direct `supports`/`derived_from`, then QMD rank, then page ID. Lower-ranked bundles are removed before evidence attached to the top bundle.

QMD's supported environment variables remain the model-override surface. pi-llm-wiki will not duplicate every QMD model setting.

### Query and intent construction

The adapter derives `query` by applying Unicode NFKC normalization, trimming, and collapsing whitespace to the explicit `wiki_recall` query or current automatic-recall prompt. It does not remove punctuation, quoted phrases, path separators, or identifier characters before QMD receives the string. Empty queries return no result. Inputs above 2,000 characters are rejected with `recall_query_too_long` rather than silently truncated.

For expanded/reranked calls, `intent` is the concatenation of non-empty vault `topic` and `mode` values from config, capped at 256 characters. It provides collection disambiguation only and never replaces or expands the query itself. If both are absent, `intent` is omitted. The full conversational transcript is never sent to QMD.

## Recall Data Flow

1. Resolve active personal and project vaults.
2. Normalize the query while preserving exact identifiers and original wording.
3. Select automatic or explicit recall policy.
4. Query applicable QMD stores using the configured retrieval mode.
5. Merge layered result lists by rank and deduplicate project/personal page ID collisions with project precedence.
6. Parse each candidate through the shared knowledge-document layer.
7. Classify canonical versus evidence role and derive status, trust, scope, and freshness warnings.
8. Apply bounded feedback and exact-match adjustments.
9. Group excerpts under their parent pages.
10. Prefer reviewed canonical cards.
11. Follow at most one typed relationship hop for direct evidence, qualifiers, superseding claims, and contradictions.
12. Pack diverse memory bundles under the context budget.
13. Render structured context for Pi or MCP.

### Automatic versus explicit recall

Automatic recall is precision-first:

- active project only when present; personal otherwise
- at most 10 candidates and 3 packed bundles
- normalized QMD score floor `0.50`
- no injection when no candidate clears that floor
- no generic graph expansion

Explicit `wiki_recall` is recall-first:

- searches personal and project stores when both exist
- accepts a larger result count
- returns alternatives and unpromoted evidence
- exposes match explanations and diagnostics

“No reliable memory found” is a valid successful outcome. The system must not fill an empty slot with a weak candidate.

## Reranking and Adjustments

QMD's reranker judges direct query usefulness. It is not a candidate generator and cannot create evidence.

After QMD ranking, pi-llm-wiki may apply only bounded, explainable adjustments for:

- exact title, alias, command, or identifier match
- stable versus draft canonical status
- current human verification (`+0.02` within the existing combined clamp)
- applicable freshness and verification state
- explicit user relevance judgment
- weak local usage evidence
- project duplicate precedence

These adjustments cannot introduce a candidate that QMD did not retrieve. Trust, freshness, and popularity must not hide an otherwise relevant conflicting claim.

## Typed-Link Expansion

Graph expansion is an assembly step after strong seed retrieval.

Rules:

- at most one hop by default
- only `supports`, `contradicts`, `qualifies`, `supersedes`, `applies_under`, and `derived_from` can add a result
- a generic Markdown or `related_to` link never forces inclusion
- evidence expansion is capped per card
- high-degree pages do not receive an automatic popularity boost
- graph-derived items are labeled with the relation that admitted them
- a contradiction neighbor is kept with its seed even when diversity selection would otherwise remove it

No graph database is needed. Existing generated backlinks plus parsed typed relations are sufficient.

## Contradictions and User Resolution

Conflicting claims are preserved separately with their dates, scope, status, and evidence. Automated detection may propose a conflict, but it cannot permanently declare one without review.

When recall finds a confirmed or plausible conflict, context shows both claims and asks the user which applies. The prompt identifies exact page IDs so the response can be applied deterministically.

An unambiguous user response causes the agent to invoke:

```text
wiki_resolve_conflict(
  vault: "personal" | "project",
  selected_page_id: string,
  other_page_id: string,
  relation: "supersedes" | "qualifies" | "applies_under",
  scope?: string,
  rationale?: string,
  replaces?: string
)
```

`selected_page_id` is the user-endorsed claim. Relation direction is always selected → other. `supersedes` means selected is current and the other claim is historical; `qualifies` means both remain stable and selected narrows the other; `applies_under` requires non-empty `scope` and means selected applies in that scope while the other remains applicable outside it. The tool rejects identical page IDs, missing pages, cross-vault pairs, invalid scope use, and any `replaces` ID that is not the active resolution for the same unordered pair.

The tool writes one atomic resolution page under `wiki/analyses/` rather than editing both claim pages:

```yaml
type: analysis
category: conflict-resolution
status: stable
resolution:
  id: <semantic-hash>
  selected: concepts/selected
  other: concepts/other
  relation: supersedes
  scope: null
  decided_by: user
  decided_at: <ISO timestamp>
  replaces: null
```

The body records the rationale and ordinary Markdown links to both claims. The ID and filename are a hash of vault ID, ordered page IDs, relation, normalized scope, and optional replaced resolution. Repeating the same operation is an idempotent no-op that returns the existing page. A changed choice requires `replaces` and creates a new immutable resolution record; recall follows the active replacement chain. A single temporary-file write, validation, and atomic rename commits the resolution. Metadata and QMD update occur afterward; failure leaves the valid resolution committed and reports stale derived state.

The resolution page is authoritative evidence of the user's choice. For `supersedes`, recall treats the other claim as historical without rewriting its `status`; for the other relations, both remain stable. The derived relation graph and feedback projection mark the selected interpretation as current for the specified scope. Pi and MCP expose identical parameters, validation codes, and structured results.

If the response is ambiguous, the system asks one clarifying question and makes no change. An LLM may map natural language to the explicit page IDs and relation, but it may not invent a third claim or silently edit unrelated content.

## Context Packing

Recall returns grouped memory bundles rather than a flat list of chunks.

Packing order:

1. highest final-score applicable canonical card, using the documented tie-breaks
2. at most two supporting evidence excerpts, ordered by typed relation and QMD rank
3. relevant qualifier, superseding claim, or competing claim
4. additional canonical cards under the `(type, domain)` diversity cap while the 8,000-character automatic budget remains
5. unpromoted evidence only when no suitable card covers the need

Every packed item includes:

- page ID and readable path
- title and type
- vault label
- exact excerpt and heading when available
- date, status, freshness, and scope when present
- match reason
- relationship to the canonical card

Deduplication prevents several chunks from one page or repeated observations from consuming the context budget. Contradictory claims remain grouped. Context truncation removes lower-value bundles before removing evidence from the highest-value bundle.

The existing links-first behavior remains useful for interactive expansion, but automatic AI context receives the compact canonical/evidence bundle directly when it fits the configured budget.

## Feedback

### Durable event format

Recall feedback is recorded through internal `recall_feedback` entries in the existing append-only `meta/events.jsonl`. To reduce accidental prompt retention, events store a SHA-256 hash of the normalized query rather than raw query text.

Each event includes:

- `schema: 1`
- timestamp
- `visibility: internal`
- stable vault ID and page ID
- query hash
- retrieval mode
- index and model versions
- shown rank
- action

Supported actions are `shown`, `opened`, `cited`, `shown_only`, `relevant`, `irrelevant`, `corrected`, and `conflict_selected`.

Instrumentation is exact:

- the recall service emits `shown` after context or links are successfully delivered
- the tool-call hook emits `opened` when a later `read` path resolves to a result shown in the active turn
- the turn-end hook emits `cited` when the assistant output contains the shown page's wikilink or ID
- the turn-end hook emits `shown_only` when no open or citation was observed; this is only an engagement proxy, not proof of irrelevance
- the agent calls `wiki_recall_feedback(vault_id, page_id, judgment, correction?)` for an explicit `relevant`, `irrelevant`, or `corrected` user statement; the pair must exist in the active session's shown-result set, `correction` is required only for `corrected`, and the service obtains the query hash from that set rather than accepting arbitrary query text
- `wiki_resolve_conflict` emits `conflict_selected`

For `corrected`, `wiki_recall_feedback` first creates a normal human-readable `source` observation containing the user's correction and a Markdown link to the corrected page, using the existing observation producer and parser validation. Its frontmatter includes `status: observation`, `category: recall-correction`, `corrected_page`, `vault_id`, and `query_hash`; this shape is how projection replay identifies it. It then appends the internal feedback event. If observation creation fails, neither event nor ranking adjustment is written. If the later event append fails, the correction page remains authoritative and the tool reports `correction_saved_feedback_pending`; a metadata rebuild can replay such correction observations into the feedback projection. `relevant` and `irrelevant` write only internal events.

`wiki_resolve_conflict` acquires the event lock before writing its resolution page, appends `conflict_selected` before releasing the lock, and aborts without a page if the lock cannot be acquired. This keeps the durable resolution and its feedback event aligned.

Copy and dwell-time signals are unavailable in Pi's current hooks and are not claimed. Explicit corrections are therefore preserved in human-readable wiki knowledge or resolution records; the event stream is not their only source of truth.

### Signal strength

- explicit correction or conflict choice: strong
- explicit relevant/irrelevant judgment: strong
- cited result: moderate
- opened result: weak positive
- `shown_only`: at most `-0.005` before decay
- result not shown: no signal

All boosts decay with a 90-day half-life, remain bounded to `±0.02` in final ranking, and apply only after retrieval. Implicit signals cannot rewrite Markdown, resolve contradictions, or make a non-candidate appear.

Feedback collection is local and enabled by default in the new major. A single boolean setting disables `shown`, `opened`, `cited`, and `shown_only` capture without disabling explicit corrections or conflict records.

## Error Handling

| Failure | Behavior |
|---|---|
| vectors missing or stale | continue with BM25; report stale vector status |
| embedding model load fails | fall back to lexical retrieval |
| reranker fails or times out | return fused hybrid results |
| QMD store cannot open | automatic recall injects nothing; explicit recall returns a structured diagnostic |
| incremental update fails | retain previous usable index and mark it stale |
| full rebuild fails | keep previous database; remove temporary replacement |
| malformed Markdown | exclude page from new results and report shared parser diagnostic |
| index/model mismatch | mark stale and recommend `wiki_reindex` |
| deleted page referenced by feedback | ignore feedback entry during aggregation |
| low confidence | return no reliable memory rather than weak results |

Model downloads and long-running indexing show visible progress. Cancellation stops new work without deleting the last usable index.

## Tools and Interfaces

### Updated

- `wiki_recall` uses the shared QMD-backed recall service.
- automatic `before_agent_start` recall uses the same service with precision-first policy.
- MCP `wiki_recall` uses the same structured operation.
- `wiki_status` reports QMD document, chunk, embedding, model, and stale-index state.
- `wiki_lint` reports missing evidence, invalid typed relations, unresolved conflict markers, and stale search state.
- `wiki_rebuild_meta` schedules incremental QMD update after successful projection rebuild.

### Added

- `wiki_reindex` consolidates lexical and vector reindexing.
- `wiki_resolve_conflict` records a user-approved resolution as one immutable analysis page.
- `wiki_recall_feedback` records explicit relevance, irrelevance, or correction judgments for an already shown `(vault_id, page_id)` result.

### Deprecated

- `wiki_reindex_embeddings` delegates to `wiki_reindex` for one major release cycle.
- the old heuristic recall and page-level embedding scorer are removed from active `wiki_recall` paths.
- `wiki_search` remains a fast exact registry lookup and is not presented as relevance-ranked recall.

## Configuration

First-release configuration remains narrow:

| Setting | Default | Meaning |
|---|---:|---|
| `retrievalMode` | `adaptive` | `lexical`, `hybrid`, `adaptive`, or `quality` |
| `recallFeedback` | `true` | capture bounded local implicit signals |
| `recallLinksThreshold` | existing default | switch interactive rendering to links-first |
| `recallSkillInlineMax` | existing default | inline recalled skills/cases |

QMD model overrides use QMD's documented environment variables. Candidate counts, adaptive thresholds, fusion constants, and feedback weights remain implementation constants until benchmark evidence justifies exposing them.

## Migration and Release

The next major release:

1. raises `engines.node` to Node.js 22 or newer
2. pins `@tobilu/qmd` to the exact published, contract-tested version `2.5.3`, raises the development TypeScript version to satisfy QMD's declared peer range, and requires adapter tests plus benchmark comparison before any QMD upgrade
3. supports the QMD package's tested native targets: Linux x64/arm64, macOS x64/arm64, and Windows x64; release CI performs clean-install smoke tests on Linux x64, macOS arm64, and Windows x64
4. treats native dependency installation failure as package installation failure with a clear supported-platform message; there is no runtime shim for an installation that never completed
5. records QMD schema version and resolved embedding, expansion, and reranker model IDs in index status
6. uses QMD's standard model cache and documents the approximately 2 GB first-use download for default embedding, reranking, and expansion models
7. verifies that `searchLex` indexes and queries without downloading or loading model files
8. creates QMD stores lazily per vault
9. keeps Markdown and existing metadata schemas readable without content migration, except for one stable `vault_id` backfill in config
10. ignores old page-level embedding sidecars after QMD activation
11. prompts users to run `wiki_reindex` for full hybrid/quality recall
12. supports immediate lexical recall after validated document indexing, even before embeddings finish
13. leaves the previous major release available for Node.js 18 users

No existing source or canonical page is deleted or rewritten merely to adopt QMD. Typed-link enrichment remains incremental and reviewable. Automated card promotion requires a separate future design.

The approved scope spans runtime migration, validated indexing, retrieval, memory assembly, feedback, and conflict resolution. It therefore requires a multi-phase implementation roadmap rather than one monolithic implementation plan.

## Evaluation

### Benchmark

Create a versioned benchmark from 50–100 real queries, with at least 20% held out from tuning. Include:

- exact note lookup
- vague recollection
- paraphrased conceptual recall
- entity and alias lookup
- “what did I conclude about” questions
- source and evidence requests
- temporal questions
- contradictory claims
- multi-note synthesis
- multilingual queries represented in the vault
- generic language that may produce dense-retrieval false positives

Each query receives graded relevance judgments for both canonical cards and evidence excerpts. Acceptable competing claims are identified for contradiction cases.

### Metrics

- candidate Recall@20
- MRR
- nDCG@5 and nDCG@10
- canonical-card-first success rate
- evidence precision and evidence recall
- contradiction coverage
- duplicate/context waste
- automatic-recall false-positive rate
- warm and cold latency by mode
- model download and steady-state resource cost

### Ablations

Run the same benchmark against:

1. current heuristic recall baseline
2. QMD lexical
3. QMD hybrid
4. adaptive reranking
5. quality mode
6. quality mode without typed-link assembly
7. quality mode without feedback adjustments

### Release gates

- every exact identifier/title benchmark query that the baseline places in the top three remains in the top three
- held-out nDCG@10 improves by at least 10% relative to the current baseline in `quality` mode
- held-out MRR does not decline by more than 2% in any mode intended to supersede the baseline
- automatic-recall false-positive rate falls by at least 25% relative to baseline
- contradiction coverage is 100% on judged conflict cases
- candidate Recall@20 does not decline by more than two percentage points
- malformed pages and unavailable models degrade as specified
- Pi and MCP return equivalent structured results
- every explicit correction becomes a persistent regression case

The first benchmark run records confidence intervals and hardware context. Constants may be tightened before implementation, but the release cannot weaken these gates without a new reviewed design decision.

## Testing Strategy

### Unit tests

- retrieval-mode parsing and fail-closed invalid values
- QMD adapter request mapping
- canonical/evidence classification
- layered rank fusion and project duplicate precedence
- bounded trust, freshness, and feedback adjustments
- typed-link admission and one-hop cap
- canonical/evidence bundle grouping
- contradiction preservation
- context deduplication and budget trimming
- query hashing and feedback aggregation
- stale and deleted feedback references
- fallback state machine

QMD adapter tests use fakes and do not load local models.

### Integration tests

- temporary Markdown vault indexed through the pinned QMD SDK
- incremental add, update, and delete through the validated mirror
- malformed or reserved pages absent from QMD candidates
- lexical recall before and without model downloads
- forced vector reindex
- complete SQLite artifact close/swap/reopen and interrupted-swap recovery
- failed rebuild preserving the prior database
- personal and project store isolation, including duplicate page IDs and feedback
- Pi/MCP parity
- automatic recall suppressing low-confidence results at specified defaults
- conflict-resolution idempotency, replacement chains, and preservation of both claims
- `relations` parse/serialize/lint/Markdown-link coexistence
- internal feedback event instrumentation and replay failure behavior

Model-heavy embedding and reranking smoke tests may use a separate CI job with cached models; ordinary unit tests must remain deterministic and network-free.

### Benchmark tests

Benchmark runs are versioned artifacts, not ordinary per-commit unit tests. Release candidates run the complete benchmark and publish mode-by-mode metrics, regressions, model versions, index versions, and hardware context.

## Risks and Mitigations

- **Generated cards distort evidence:** require exact source references and review before stable status.
- **Dense retrieval overmatches generic prose:** preserve BM25, use RRF and reranking, and include this failure class in the benchmark.
- **Reranker hides minority evidence:** add contradiction neighbors after seed ranking and test contradiction coverage.
- **Implicit feedback creates popularity bias:** keep it weak, bounded, decayed, and post-retrieval only.
- **QMD/model upgrade changes ranking:** record versions, mark affected indexes stale, and rerun benchmark before release.
- **Native dependency or model failure:** supported-platform clean-install CI catches native packaging defects; runtime model failures fall back to QMD lexical search or no injection with clear diagnostics.
- **Index contains sensitive content:** keep it under protected local `meta/`, exclude it from OKF exports, and document that full-vault backups contain derived searchable text.
- **Graph hubs dominate:** only typed one-hop relationships can add candidates; generic links do not boost rank.
- **Over-atomization harms browsing:** atomicity follows useful idea boundaries, not arbitrary size limits.
- **Stale sidecars:** content hashes, incremental updates, status diagnostics, and explicit reindexing keep them rebuildable.

## Success Criteria

The design succeeds when:

1. unrelated automatic recall is measurably reduced
2. reviewed canonical cards appear before raw observations for judged queries
3. correct evidence accompanies the selected card
4. relevant conflicts appear together and remain unresolved until user input
5. lexical recall works without loading local models
6. adaptive and quality modes materially improve held-out ranking
7. users can inspect status and repair search with one reindex tool
8. feedback improves repeated use without mutating facts
9. Obsidian and plain Markdown workflows remain intact
10. all generated search state can be rebuilt from Markdown plus durable feedback events

## Research References

- QMD repository and SDK documentation: https://github.com/tobi/qmd
- Obsidian Graph View documentation: https://obsidian.md/help/plugins/graph
- Zettelkasten introduction: https://zettelkasten.de/introduction/
- Zettelkasten atomicity guide: https://zettelkasten.de/atomicity/guide/
- Reciprocal Rank Fusion, Cormack, Clarke, and Buettcher: https://doi.org/10.1145/1571941.1572114
- Existing pi-llm-wiki architecture: `docs/architecture.md`
- Existing OKF interoperability design: `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md`
