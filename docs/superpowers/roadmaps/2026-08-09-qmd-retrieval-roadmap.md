# QMD-Backed Second-Brain Retrieval Roadmap

> **For agentic workers:** Use /skill:writing-plans to create one detailed implementation plan per phase. Start with Phase 1 and proceed sequentially unless the user explicitly changes the order.

**Goal:** Replace heuristic wiki recall with measured QMD-backed retrieval that returns canonical knowledge, evidence, and conflicts safely across personal and project vaults.

**Design Spec:** [`docs/superpowers/specs/2026-08-08-qmd-retrieval-design.md`](../specs/2026-08-08-qmd-retrieval-design.md)

**Planning Strategy:** This change spans runtime compatibility, local native dependencies, indexing, retrieval cutover, knowledge semantics, feedback, conflict resolution, and release validation. Seven ordered phases keep each detailed plan within one context window, establish quality measurements before tuning, and leave the existing package functional at every boundary.

---

## Phase Map

| Phase | Outcome | Depends on |
|---|---|---|
| 1. Quality Baseline and QMD Compatibility | Reproducible benchmark plus proven Node/QMD build contract | Approved design |
| 2. Validated QMD Indexing | Rebuildable per-vault QMD indexes and `wiki_reindex` | Phase 1 |
| 3. Retrieval Modes and Recall Cutover | QMD powers Pi, MCP, and automatic recall | Phase 2 |
| 4. Card-First Memory Assembly | Canonical cards, evidence, typed links, and conflicts are packed deterministically | Phase 3 |
| 5. User Conflict Resolution | User decisions become immutable, scoped resolution records | Phase 4 |
| 6. Retrieval Feedback | Explicit and implicit signals produce bounded local reranking adjustments | Phase 5 |
| 7. Hardening and Major Release | Release gates pass and migration/documentation ship | Phases 1–6 |

---

## Phase 1: Quality Baseline and QMD Compatibility

**Outcome:** The repository has a versioned retrieval benchmark, current-system baseline metrics, and a verified dependency/runtime contract for the pinned QMD release without changing active recall behavior.

**Why now:** Retrieval quality cannot be improved responsibly without a baseline, and all later phases depend on QMD's actual SDK, native packages, model behavior, and supported platforms matching the design assumptions.

**Scope:**
- Define the benchmark schema for queries, graded canonical-card relevance, evidence relevance, contradiction expectations, and held-out membership.
- Build a deterministic benchmark runner for the current heuristic recall path and record baseline metrics.
- Curate 50–100 sanitized queries representing the approved query categories, including dense-retrieval false positives and multilingual cases present in the corpus.
- Raise development and CI toolchains to Node.js 22 and a TypeScript version compatible with the pinned QMD peer range.
- Pin and contract-test the published `@tobilu/qmd` 2.5.3 package, including the SDK calls required by all four retrieval modes.
- Add clean-install/native-package smoke coverage for the supported release platforms.
- Verify lexical QMD operation without model download and document default model cache/download expectations.

**Out of scope:**
- Creating persistent QMD vault indexes.
- Routing production recall through QMD.
- Tuning ranking constants against the held-out benchmark set.
- Card assembly, conflict resolution, or feedback.

**Key files/areas likely affected:**
- `package.json` and `pnpm-lock.yaml`: Node, TypeScript, and pinned QMD dependency contract.
- `.github/workflows/`: supported-platform clean-install and model-smoke jobs.
- `test/fixtures/`: sanitized benchmark corpus and graded judgments.
- `scripts/` or `test/`: benchmark runner and metric reporting.
- `extensions/llm-wiki/lib/recall.ts`: stable baseline adapter only; active behavior remains unchanged.
- `docs/`: benchmark methodology, privacy rules, and hardware/model reporting.

**Dependencies:**
- Approved design spec.
- Access to representative queries that can be sanitized before entering the repository.
- QMD 2.5.3 package and supported native binaries remaining available.

**Verification:**
- Existing typecheck, lint, and test suites pass on Node.js 22.
- Clean package installation succeeds on Linux x64, macOS arm64, and Windows x64 CI.
- QMD SDK contract tests cover lexical, typed hybrid, expanded/reranked, update, embed, status, and close operations.
- Benchmark runner reproduces the same baseline metrics from the same fixture and emits Recall@20, MRR, nDCG, card/evidence measures, contradiction coverage, and false-positive rate.
- Lexical QMD smoke test performs no model download or load.

**Phase boundary health:** Active wiki recall is still the current implementation, so users do not receive a half-integrated engine. The package has moved to its next-major runtime floor, but all existing functionality and CI remain green.

**Risks:**
- QMD's published SDK may differ from documentation; treat contract-test failure as a design dependency failure before production integration.
- Personal benchmark queries may expose private data; sanitize fixtures and keep any private source benchmark outside version control.
- Native CI may be slow or flaky; separate install smoke from cached model-heavy tests.

**Context notes:** The detailed plan should focus on measurement and compatibility, not begin production indexing. Record immutable benchmark train/held-out membership before later ranking work.

---

## Phase 2: Validated QMD Indexing

**Outcome:** Each vault can build, incrementally update, inspect, and safely replace a QMD index derived only from parser-valid Markdown, while active recall still has a safe existing path.

**Why now:** Retrieval cannot cut over until indexing excludes malformed or reserved pages, maintains personal/project isolation, survives interrupted rebuilds, and exposes a repair command.

**Scope:**
- Add stable `vault_id` creation and one-time backfill while preserving existing config.
- Introduce a QMD adapter boundary that hides QMD-specific types from shared wiki services.
- Build canonical/evidence mirror trees from successfully parsed `KnowledgeDocument` pages.
- Maintain the mirror-to-authoritative-path manifest and exclude reserved generated pages.
- Create one independent QMD store per vault with non-overlapping canonical and evidence collections.
- Support incremental add, update, invalidation, and deletion.
- Implement recoverable full-store replacement covering SQLite, WAL/SHM, and native sidecars as one closed artifact directory.
- Add `wiki_reindex` for lexical/vector, changed/all, force, and vault scopes.
- Extend status and lint diagnostics for index health, stale content, models, and interrupted swaps.
- Schedule incremental indexing only after successful metadata projection rebuilds.

**Out of scope:**
- Replacing `wiki_recall` ranking.
- Adaptive or quality query execution.
- Typed knowledge relations or card-first context packing.
- Feedback and conflict-resolution events.

**Key files/areas likely affected:**
- `extensions/llm-wiki/lib/indexing.ts`: indexing coordination and stale-state reporting.
- `extensions/llm-wiki/lib/knowledge-document.ts`: validated mirror input contract.
- `extensions/llm-wiki/lib/bootstrap.ts` and `extensions/llm-wiki/lib/utils.ts`: vault IDs and generated paths.
- New QMD adapter/index-store module under `extensions/llm-wiki/lib/`.
- `extensions/llm-wiki/lib/task-config.ts`: index-related configuration parsing where needed.
- `extensions/llm-wiki/lib/tools.ts` and `extensions/llm-wiki/lib/wiki-service.ts`: reindex/status shared operations.
- `extensions/llm-wiki/lib/guardrails.ts`: generated QMD ownership and post-rebuild scheduling.
- `mcp/operations.ts`: parity for reindex and status.
- `test/indexing.test.ts`, `test/indexing-fail-closed.test.ts`, and new QMD indexing tests.

**Dependencies:**
- Phase 1's pinned, contract-tested QMD SDK and Node.js 22 runtime.
- Existing shared document parser and fail-closed projection behavior.

**Verification:**
- Valid pages appear in the correct mirror collection and map back to their authoritative paths.
- Malformed, deleted, and reserved pages cannot enter QMD candidates.
- Incremental indexing reports accurate indexed, changed, unchanged, removed, and embedding-needed counts.
- Forced rebuild closes, swaps, reopens, and validates the complete QMD artifact.
- Simulated interruption at each swap phase recovers or rolls back to a usable store.
- Personal and project indexes remain isolated even when page IDs collide.
- `wiki_reindex`, status, Pi, and MCP return equivalent structured results.

**Phase boundary health:** Existing recall remains functional. QMD indexing is independently usable and repairable through `wiki_reindex` and status, but no automatic context depends on it yet.

**Risks:**
- Mirror and manifest can diverge after a crash; reconcile both from authoritative Markdown before every full rebuild and during startup recovery.
- Native stores may retain open handles; require explicit close and validation before any directory swap.
- Background embedding can consume resources unexpectedly; lexical-only indexing must remain model-free and vector work visible/cancellable.

**Context notes:** Keep QMD table details private to its SDK. The detailed plan should treat generated mirror, manifest, and store as one lifecycle without manipulating QMD's schema directly.

---

## Phase 3: Retrieval Modes and Recall Cutover

**Outcome:** QMD becomes the single active relevance engine for explicit recall, automatic injection, and MCP, with lexical, hybrid, adaptive, and quality modes plus deterministic fallback.

**Why now:** The validated stores and repair path from Phase 2 are prerequisites for switching production queries without risking malformed-content influence or unrecoverable failures.

**Scope:**
- Implement exact SDK mappings for lexical, typed hybrid, adaptive escalation, and quality retrieval.
- Normalize queries and construct bounded vault intent according to the spec.
- Apply deterministic adaptive triggers, confidence floors, candidate limits, and exact-match bypass.
- Merge personal/project ranked lists using rank-based normalization and project duplicate precedence.
- Preserve exact identifiers, titles, aliases, commands, paths, and filenames.
- Route `wiki_recall`, automatic `before_agent_start` recall, and MCP through one shared retrieval service.
- Keep automatic recall precision-first and explicit recall broader.
- Preserve links-first rendering and skill/case inlining behavior where applicable.
- Implement model/store fallback chains and structured diagnostics.
- Remove the old heuristic scorer and page-level embedding path from active recall after parity checks pass.
- Deprecate `wiki_reindex_embeddings` through the consolidated reindex operation.

**Out of scope:**
- Typed-link evidence expansion.
- Canonical/evidence bundle assembly beyond role labels.
- User conflict decisions.
- Learning from feedback.

**Key files/areas likely affected:**
- `extensions/llm-wiki/lib/recall.ts`: shared QMD-backed query and layered merge behavior.
- QMD adapter module from Phase 2: mode-specific SDK calls and fallback.
- `extensions/llm-wiki/lib/task-config.ts`: `retrievalMode` validation and defaults.
- `extensions/llm-wiki/index.ts`: automatic recall integration and cache-safe dynamic context.
- `extensions/llm-wiki/lib/inject.ts`: unchanged cache boundary with new structured recall blocks.
- `extensions/llm-wiki/lib/wiki-service.ts`: shared Pi/MCP operation.
- `mcp/operations.ts`: recall parity.
- `test/recall.test.ts`, `test/agent-start-injection.test.ts`, and `test/mcp-parity.test.ts`.
- `extensions/llm-wiki/lib/embeddings.ts`: retirement or compatibility handling for the old sidecar path.

**Dependencies:**
- Phase 2's validated, healthy QMD stores and status diagnostics.
- Phase 1's SDK contract tests and baseline benchmark.

**Verification:**
- Each retrieval mode invokes only its specified QMD SDK path.
- Missing vectors, model failures, reranker timeouts, and store failures follow the designed fallback chain.
- Automatic recall injects nothing below the confidence floor.
- Exact lookup remains within release-gate tolerance against the baseline.
- Personal/project merging is deterministic and duplicate-safe.
- Pi automatic recall, explicit tool recall, and MCP produce equivalent structured candidates.
- Existing tests remain green after the old scorer leaves active paths.

**Phase boundary health:** Retrieval is fully usable through QMD in every supported mode, but results still use a conservative flat presentation. Later semantic assembly can improve context without changing the retrieval engine again.

**Risks:**
- QMD scores may vary by mode or model; use them only for within-store confidence and ranks for cross-store merging.
- Query expansion can introduce drift; adaptive mode retains the initial hybrid list on reranker failure and lexical mode stays available.
- Cutover could increase cold latency; expose progress/status and retain precision-first no-injection behavior.

**Context notes:** This phase should end dual-engine behavior. Transitional comparison may exist in tests or benchmark tooling, not as two production ranking paths.

---

## Phase 4: Card-First Memory Assembly

**Outcome:** Recall returns deterministic memory bundles containing the best canonical card, bounded evidence, qualifiers, and competing claims instead of a flat page list.

**Why now:** QMD must first provide reliable candidates. This phase adds wiki-specific semantics without entangling them with indexing or model integration.

**Scope:**
- Classify canonical and evidence roles from parsed page types and status.
- Add the optional `relations` profile field with parse, validation, serialization, and lint behavior.
- Require matching ordinary Markdown links so Obsidian and plain Markdown navigation remain intact.
- Build typed relation adjacency without duplicate backlink edges.
- Apply bounded status, human-verification, exact-match, freshness, and trust adjustments.
- Expand at most one hop through evidence, qualification, supersession, applicability, derivation, and contradiction relations.
- Group chunks by parent page and create `MemoryBundle` structures.
- Enforce automatic bundle count, excerpt count/length, diversity, tie-break, and context-budget rules.
- Label raw matches as unpromoted evidence when no suitable canonical page exists.
- Render match reasons, provenance, scope, freshness, relation type, and conflicts.
- Keep generic `related_to` and untyped links out of automatic expansion.

**Out of scope:**
- Automatically creating or promoting canonical cards.
- Persisting user conflict choices.
- Feedback-derived score adjustments.
- Graph database or multi-hop traversal.

**Key files/areas likely affected:**
- `extensions/llm-wiki/lib/knowledge-document.ts`: typed relation extension model.
- `extensions/llm-wiki/lib/knowledge-links.ts`: relation/link coexistence and normalized target resolution.
- `extensions/llm-wiki/lib/metadata.ts`: typed adjacency projection and diagnostics.
- `extensions/llm-wiki/lib/recall.ts` or a focused memory-assembly module: grouping and bounded adjustments.
- `extensions/llm-wiki/lib/wiki-service.ts`: structured bundle output.
- `extensions/llm-wiki/lib/tools.ts`: rendering and diagnostics.
- `test/knowledge-document.test.ts`, `test/knowledge-links.test.ts`, `test/recall.test.ts`, and OKF integration fixtures.
- `docs/obsidian.md` and architecture documentation: human graph behavior and profile field.

**Dependencies:**
- Phase 3's shared, QMD-backed candidate stream.
- Existing OKF shared parser/serializer and backlink projections.

**Verification:**
- Relation metadata round-trips and unknown relation types remain preserved but inert.
- Lint catches missing body links, invalid scopes, duplicates, self-links, and unresolved targets.
- A canonical card precedes equally relevant evidence without introducing non-candidates.
- Evidence and contradictions expand only through allowed one-hop relations.
- Context packing obeys all count, length, diversity, and budget limits deterministically.
- Obsidian still sees ordinary Markdown links and backlinks do not duplicate edges.
- Card/evidence benchmark measures improve without violating exact-lookup or Recall@20 gates.

**Phase boundary health:** Recall now delivers useful card-first context with provenance and visible unresolved conflicts. It does not yet mutate knowledge based on those conflicts or usage.

**Risks:**
- Canonical boosts may overpower relevance; keep the combined multiplier clamped and benchmarked.
- Relation metadata may diverge from body links; lint makes the relation inert until both agree.
- Dense results can duplicate evidence; parent-page deduplication and fixed excerpt caps protect context.

**Context notes:** Keep all assembly logic pure where possible. Do not add card-promotion workflows; they require a separate future design.

---

## Phase 5: User Conflict Resolution

**Outcome:** When competing claims appear, an explicit user choice can be recorded as an immutable, scoped, idempotent resolution with identical Pi and MCP behavior.

**Why now:** Conflict records depend on Phase 4's typed relations and memory bundles. Implementing this before general feedback also establishes the durable internal-event and writer-lock foundation that feedback will reuse.

**Scope:**
- Extend the authoritative event service with internal-event visibility and cross-process per-vault locking.
- Ensure human-readable logs omit internal feedback events while full-vault backups retain them.
- Implement `wiki_resolve_conflict` with exact page IDs, relation direction, scope rules, rationale, and replacement-chain validation.
- Write one immutable resolution analysis page per semantic decision using atomic single-file publication.
- Derive active resolution state without rewriting or deleting competing claim pages.
- Add idempotent replay and replacement behavior.
- Emit `conflict_selected` internal events and keep them aligned with committed resolution pages.
- Update metadata, relation projections, indexing, status, and recall after resolution.
- Expose the same tool parameters, result codes, and validation through Pi and MCP.

**Out of scope:**
- Automatic contradiction resolution.
- General relevance/irrelevance feedback.
- Rewriting historical claim status.
- Multi-party approvals or voting.

**Key files/areas likely affected:**
- `extensions/llm-wiki/lib/metadata.ts`: event visibility, locking, replay, and projections.
- New focused conflict-resolution service under `extensions/llm-wiki/lib/`.
- `extensions/llm-wiki/lib/knowledge-document.ts`: resolution metadata validation.
- `extensions/llm-wiki/lib/knowledge-links.ts`: resolution links and derived relation direction.
- `extensions/llm-wiki/lib/tools.ts` and `extensions/llm-wiki/lib/wiki-service.ts`: shared operation and Pi tool.
- `mcp/operations.ts`: MCP parity.
- `extensions/llm-wiki/lib/indexing.ts`: post-resolution incremental update.
- Conflict, event-concurrency, mutation-guard, and parity tests.
- `docs/architecture.md` and OKF ownership documentation: internal events and resolution records.

**Dependencies:**
- Phase 4's typed relation model and contradiction bundles.
- Existing event stream and atomic knowledge-document writer patterns.

**Verification:**
- Invalid, cross-vault, same-page, or malformed-scope decisions make no writes.
- Repeating the same decision returns the existing resolution.
- Changed choices require a valid `replaces` chain and preserve old records.
- Lock contention follows explicit-event timeout behavior without partial knowledge mutation.
- Resolution pages preserve both claim links and all prior provenance.
- Recall follows the active resolution for applicable scope while retaining the competing claim for audit.
- Pi and MCP results are structurally equivalent.

**Phase boundary health:** Conflict handling is complete and useful without general behavioral learning. Existing recall remains deterministic when no resolution exists.

**Risks:**
- Event/page publication can diverge on I/O failure; acquire the event lock before publication and test rollback/replay states.
- User language can be ambiguous; only explicit resolved page IDs and relation choices reach the mutation service.
- Synced vaults may retain stale locks; use the specified owner/time recovery rule and surface unresolved locks through lint/status.

**Context notes:** The detailed plan should preserve one authoritative decision record rather than coordinating edits across both claim pages.

---

## Phase 6: Retrieval Feedback

**Outcome:** Local explicit and observable implicit feedback produces small, decaying, explainable ranking adjustments without rewriting facts or introducing candidates.

**Why now:** Feedback needs stable QMD result identities, card-first results, active-turn tracking, and the internal-event concurrency semantics established in earlier phases.

**Scope:**
- Add `recall_feedback` schema-versioned internal events keyed by stable vault/page identity and query hash.
- Track shown results per active turn.
- Instrument `shown`, `opened`, `cited`, and `shown_only` through the specified service and hooks.
- Implement `wiki_recall_feedback` for explicit relevance, irrelevance, and correction judgments on previously shown results.
- Preserve corrections as human-readable source observations before appending feedback events.
- Build and replay the generated feedback aggregate projection.
- Apply the 90-day half-life, signal strengths, and total `±0.02` post-retrieval clamp.
- Disable feedback safely on event-source corruption or configuration opt-out.
- Expose feedback state and diagnostics without storing raw query text.
- Add correction cases to the retrieval regression corpus.

**Out of scope:**
- Copy, dwell-time, or unavailable UI signals.
- Online model training.
- Global or cross-user feedback sharing.
- Feedback-based candidate generation or fact mutation.
- Automated card promotion.

**Key files/areas likely affected:**
- New focused feedback aggregation module under `extensions/llm-wiki/lib/`.
- `extensions/llm-wiki/lib/metadata.ts`: internal event replay and projection preservation.
- `extensions/llm-wiki/lib/guardrails.ts` or extension hooks: read/open observation.
- `extensions/llm-wiki/index.ts`: active-turn shown/cited lifecycle.
- `extensions/llm-wiki/lib/observation.ts`: correction observation producer reuse.
- `extensions/llm-wiki/lib/recall.ts` or memory-assembly module: bounded post-retrieval adjustment.
- `extensions/llm-wiki/lib/task-config.ts`: `recallFeedback` setting.
- `extensions/llm-wiki/lib/tools.ts`, `wiki-service.ts`, and `mcp/operations.ts`: explicit feedback operation and parity.
- Feedback, event replay, hook instrumentation, privacy, and ranking-bound tests.

**Dependencies:**
- Phase 3's stable QMD result identity and active recall service.
- Phase 4's final ranking/assembly boundary.
- Phase 5's internal event visibility and writer locking.

**Verification:**
- Raw query text never enters feedback events.
- Identical page IDs in different vaults receive independent signals.
- Only results shown in the active session can receive explicit feedback.
- Each observable hook emits the documented action; unavailable signals are not claimed.
- Corrupt events disable adjustments and preserve the last projection.
- Deleted pages and stale event references cannot affect ranking.
- Aggregate feedback never exceeds its clamp or introduces a non-candidate.
- Disabling implicit feedback leaves explicit corrections and conflict records working.

**Phase boundary health:** The full retrieval experience now learns conservatively from use while Markdown facts and candidate generation remain unchanged.

**Risks:**
- Position and engagement bias can reinforce popular pages; keep implicit weights tiny and decayed.
- Turn-hook instrumentation may misclassify use; `shown_only` remains a minimal proxy, never strong negative evidence.
- Event volume can grow; no compaction ships in this release, so status should report size for future evidence-based work.

**Context notes:** Keep feedback aggregation deterministic and replayable. Do not broaden the event schema into a general analytics platform.

---

## Phase 7: Hardening and Major Release

**Outcome:** The next major version ships with documented migration, supported-platform validation, published quality metrics, and all release gates passing.

**Why now:** Final migration, removals, documentation, and versioning should happen only after every capability is integrated and measured together.

**Scope:**
- Run all retrieval-mode ablations on train and held-out benchmark sets with recorded model/index versions and hardware context.
- Tune only implementation constants allowed by the spec while preserving the held-out set.
- Enforce exact lookup, nDCG, MRR, false-positive, contradiction, and Recall@20 release gates.
- Run model-heavy smoke tests with cached pinned models.
- Complete migration handling for `vault_id`, lazy indexes, stale old embedding sidecars, and first-run reindex prompts.
- Confirm QMD model-cache behavior, first-use download messaging, cancellation, and runtime fallback.
- Finalize deprecation behavior for `wiki_reindex_embeddings` and remove old active scorer code that no longer serves compatibility or benchmark needs.
- Update README, configuration, API, architecture, Obsidian, troubleshooting, migration, and release documentation.
- Publish supported-platform and Node.js 22 requirements prominently.
- Prepare changelog and use the release script for the major version; never edit the package version manually.

**Out of scope:**
- Automated canonical-card promotion.
- Graph database or graph viewer work beyond existing Obsidian compatibility.
- Additional QMD backends or remote rerankers.
- Feedback compaction or learned ranking models.
- Features deferred by the approved design.

**Key files/areas likely affected:**
- Benchmark fixtures, reports, and release-gate scripts.
- `package.json`, `pnpm-lock.yaml`, and `scripts/release.js` integration.
- `.github/workflows/`: full release matrix and cached model smoke.
- `README.md`, `docs/configuration.md`, `docs/api.md`, `docs/architecture.md`, `docs/obsidian.md`, and troubleshooting/migration docs.
- `CHANGELOG.md`.
- Legacy recall/embedding modules and tests retained only where still required.
- Package smoke and MCP parity tests.

**Dependencies:**
- Completion of Phases 1–6.
- Release-candidate benchmark results meeting every approved gate.
- Supported-platform CI availability.

**Verification:**
- Full typecheck, lint, unit, integration, MCP, package-smoke, and supported-platform suites pass.
- Held-out benchmark satisfies every numeric release gate.
- Fresh vault, existing personal vault, and project-plus-personal vault migration scenarios work without content loss.
- Lexical mode works without model downloads; hybrid/adaptive/quality provide clear model progress and fallback.
- Full reindex repairs stale or interrupted state.
- Documentation matches actual tool schemas, settings, model sizes, platform support, and deprecations.
- Release artifact installs and runs on each claimed platform.

**Phase boundary health:** This is the final coherent release boundary. The previous major remains available for Node.js 18 users, while the new major has one active retrieval engine and no undocumented migration requirement.

**Risks:**
- Benchmark tuning can overfit; preserve held-out judgments and publish ablations.
- Native/model packaging can regress late; require clean-install and cached model smoke before tagging.
- Major-release documentation may understate storage/model cost; include explicit generated-index and full-vault-backup implications.

**Context notes:** Use the release script only after the release candidate passes every gate. If a gate fails, return to the owning phase rather than weakening the criterion during release work.

---

## Deferred Follow-Up Designs

The following work remains intentionally outside this roadmap:

- evidence-driven canonical-card promotion and review queues
- graph visualization beyond Obsidian compatibility
- graph databases or multi-hop agentic retrieval
- remote or alternative reranker providers
- feedback-log compaction and retention controls
- personalized learned ranking models
- automatic contradiction detection beyond proposed, reviewable links

Each item requires evidence from production retrieval and its own reviewed design before implementation.
