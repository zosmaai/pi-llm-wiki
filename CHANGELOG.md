# Changelog

## [Unreleased]

### Fixed
- **Personal wiki created at doubled path `~/.llm-wiki/.llm-wiki/…`**: `getPersonalWikiRoot()` returned the dot-dir itself (`~/.llm-wiki`) while `getVaultPaths()` then appended another `.llm-wiki/` segment, so the personal vault was written to `~/.llm-wiki/.llm-wiki/wiki/…`. Fixed by aligning `getPersonalWikiRoot()` with the same "root = parent of `.llm-wiki/`" contract used by project vaults. `WIKI_HOME` continues to override the parent.

### Added
- **Hybrid lexical + semantic recall ranking, LLM-free hot path** (Issue #67, part of epic #63): recall now blends the existing weighted lexical score with **semantic cosine similarity** against the precomputed `meta/embeddings.json` sidecar (#66), so paraphrased queries surface pages that pure keyword matching misses.
  - **No re-embedding per query**: page vectors are computed at write time (#66). The only per-query embedding work is a **single, cached** lookup of the (short) query string via the configured embedder (`searchWikiHybrid` in `extensions/llm-wiki/lib/recall.ts`); repeated recalls of the same query in a session reuse the cached vector. Ranking itself (`searchWiki`) stays **synchronous and offline** — pure vector math, no network.
  - **Score fusion**: the lexical score keeps its original absolute scale and the semantic signal is added as a bounded, weighted, non-negative boost (`fuseScores` = `lexical + semanticWeight × SEMANTIC_SCALE × max(cosine, 0)`). This preserves `minScore` semantics for auto-injection noise control — a semantic-only match must be **strongly** relevant (cosine ≳ 0.84 at the default weight) to clear the auto-inject threshold. New `semanticWeight` setting (namespaced `llm-wiki`, default `0.5`, clamped to `[0,1]`).
  - **Pure-lexical fallback preserved**: with no embeddings sidecar (or no embedder configured) the query embedding is **skipped entirely** (zero network) and recall is byte-for-byte the prior lexical behavior. Embedding/network failures degrade gracefully to lexical. The `wiki_recall` tool and the `before_agent_start` auto-injection both use the hybrid path.
  - **8 tests** (`test/recall.test.ts`): score-fusion math, paraphrase recall (semantic-only page surfaced), ranking reorder vs pure lexical, no-sidecar regression (identical to lexical), empty/missing-sidecar safety, `minScore` still filtering weak cosine, and the hybrid wrapper skipping vs performing+caching the single query embedding. Embedding is mocked — no network in tests.
- **Background semantic embeddings computed at write time** (Issue #66, part of epic #63): every wiki page gets a normalized embedding vector computed in the **background**, so future semantic retrieval (#67) can rank pages **without any embedding/LLM call in the query hot path**.
  - `extensions/llm-wiki/lib/embeddings.ts`: stores vectors in a `meta/embeddings.json` sidecar keyed by page id, each with a **content hash + model** for staleness detection. `embedPages()` embeds a set of pages (skipping fresh ones unless `force`); `reindexEmbeddings()` backfills an entire vault and prunes entries for deleted pages. Vectors are L2-normalized for cosine; `cosineSimilarity()` is exported for #67.
  - **Write-time triggers (all background, never block the agent)**: ingest commit embeds the source + entity/concept pages it wrote; `wiki_ensure_page` embeds the new page; manual wiki edits are re-embedded after the end-of-turn metadata rebuild. All single-flight per label via the #64 runtime.
  - **Configurable, OpenAI-compatible provider** (mirrors memex): new `embeddingProvider` / `embeddingModel` / `embeddingBaseUrl` / `embeddingApiKey` / `embeddingApiKeyEnv` fields in the namespaced `llm-wiki` settings (`extensions/llm-wiki/lib/task-config.ts`). The embedding API key has its **own** auth path, independent of the chat-model resolution.
  - **New `wiki_reindex_embeddings` tool**: backfill an existing vault or refresh stale pages (`force` to re-embed everything).
  - **Fully optional, no-op by default**: with no `embeddingProvider` configured, embeddings are disabled silently and existing lexical search is completely unaffected. Opt-in is explicit — an ambient `OPENAI_API_KEY` alone does **not** enable it.
  - **23 tests** (`test/embeddings.test.ts`, additions to `test/runtime.test.ts`): write-time embedding + normalized storage, content-hash and model staleness, `force`, backfill + prune, the no-provider no-op (and no auto-enable), vector math, and config parsing. Embedding is mocked — no network in tests.
- **Background ingest synthesis** (Issue #65, part of epic #63): `wiki_ingest` now synthesizes captured sources in the **background by default** — the main agent is no longer blocked while source pages and entity/concept pages are written.
  - New `background` parameter (default `true`). When a task model resolves, each source is dispatched to a background sub-agent via the #64 runtime and the tool returns immediately with a non-blocking notification; the main agent is told **not** to synthesize those sources itself. The sub-agent makes one structured `commit_synthesis` call.
  - **Graceful fallback**: when no model/API key is available (or `background=false`), `wiki_ingest` returns the extracted batch exactly as before for the main agent to synthesize — fully backward compatible.
  - `extensions/llm-wiki/lib/ingest-worker.ts`: `commitSynthesis()` deterministically rewrites the source page (`status: skeleton → ingested`), creates missing entity/concept pages (existing pages are linked, never overwritten), records an `ingest` event, and rebuilds metadata. `runIngestSynthesis()` drives the synthesis sub-agent. `buildIngestedSourcePage()` renders the filled page.
  - **10 tests** (`test/ingest-worker.test.ts`, `test/ingest-tool.test.ts`): deterministic page/entity/concept writing, link-don't-overwrite, event logging, empty-slug safety, and tool-level background dispatch + all three fallback paths (no model, `background=false`, no runtime).
- **Background-task lane infrastructure** (Issue #64, part of epic #63): foundational runtime so wiki tasks can run off the main agent thread without blocking the user.
  - `Runtime` (`extensions/llm-wiki/lib/runtime.ts`): `launchTask()` fires detached, single-flight-per-label background work with isolated error handling; `resolveModel()` picks the configured `taskModel` → session-model fallback → API-key resolution, returning a graceful `{ ok: false }` so callers keep the synchronous path when no model/key is available; `awaitAll()` drains in-flight work.
  - `registerBackgroundRuntime()`: wires the runtime into the extension lifecycle, draining in-flight tasks on `session_before_compact` and `session_shutdown` so background work is never lost.
  - `loadTaskConfig()` (`extensions/llm-wiki/lib/task-config.ts`): reads an optional `taskModel` from pi's namespaced `llm-wiki` settings (global + project). Zero-config by default.
  - `runSubAgent()` (`extensions/llm-wiki/lib/subagent.ts`): thin, generic `agentLoop` wrapper for focused background sub-agents.
  - **15 unit tests** (`test/runtime.test.ts`) covering config precedence, model resolution + fallbacks, single-flight, concurrency, error isolation, and drain.
  - No user-facing behavior change yet; concrete workers land in #65 (background ingest) and #66 (background embeddings).
- **Test isolation fix** (`test/recall.test.ts`): the personal-vault recall suite now sandboxes `WIKI_HOME` to a temp dir per test, so it no longer reads (or writes) the developer's real `~/.llm-wiki`. Previously these tests passed only by scheduling luck and could pollute the real home vault.
- **`migrateDoubledPersonalVault()`** helper (`extensions/llm-wiki/lib/utils.ts`): Idempotent, in-place flatten of any vault that was already written to the broken doubled layout. Moves entries from `<root>/.llm-wiki/.llm-wiki/*` up to `<root>/.llm-wiki/*`, preserves outer entries on collision, removes the inner dir only when fully drained. Returns `null` when the layout is already correct, so it is safe to call on every session start.
- **Auto-migration on `session_start`**: The extension now runs `migrateDoubledPersonalVault()` on the personal wiki at every session start. Existing broken vaults are flattened the next time the user opens or reloads pi — no manual step required. A one-line status message is shown when a flatten actually happens; otherwise the check is silent.
- **`scripts/migrate-llm-wiki.js --fix-doubled`** flag: Manual recovery for arbitrary roots (`--fix-doubled ~/`, `--fix-doubled /some/project`). Supports `--dry-run` and `--force`.
- **9 regression tests** (`test/personal-wiki-paths.test.ts`): pin `getPersonalWikiRoot()` to the parent-of-dotdir contract, exercise `WIKI_HOME`, and verify the migration helper across no-op, idempotent, and collision paths.

## [0.7.0] - 2026-05-13

### Added
- **Wiki vault restructured under `.llm-wiki/`** (Issue #22, PR #23 by @arjun-zosma): All wiki content now lives in a single `.llm-wiki/` subdirectory — cleaner repo isolation, easier gitignore, zero directory name collisions.
- **Backward compatibility**: Old vaults (`.wiki/config.json` sentinel) are auto-detected and continue to work. New vaults use `.llm-wiki/config.json`.
- **`detectVaultFormat()`** utility: Returns `"new"`, `"legacy"`, or `"none"` for any directory.
- **`resolveVaultPaths()`** utility: Auto-detects vault format and returns correct paths.
- **`getLegacyVaultPaths()`** utility: Returns old-style paths for migration support.
- **Migration script** (`scripts/migrate-llm-wiki.js`): One-time tool to move old vaults to new layout. Supports `--dry-run` and `--force` flags.
- **5 new backward-compatibility tests**: Verify new format detection, legacy format detection, auto-resolution, and no-vault handling.

### Changed
- `resolveVaultRoot()` now checks for `.llm-wiki/config.json` first, then falls back to `.wiki/config.json`.
- `getVaultPaths()` returns paths under `.llm-wiki/`:
  - `raw/` → `.llm-wiki/raw/`, `wiki/` → `.llm-wiki/wiki/`, `meta/` → `.llm-wiki/meta/`
  - `.wiki/` → `.llm-wiki/` (config directly in the dot-dir)
  - `outputs/` → `.llm-wiki/outputs/`, `.discoveries/` → `.llm-wiki/.discoveries/`
- `isProtectedPath()` now takes `VaultPaths` instead of `root` string.
- `wiki_bootstrap` creates new `.llm-wiki/` layout by default.
- MCP server updated with own copy of path detection logic.
- All templates, prompts, documentation, and tests updated to reflect new layout.

### Migration
- Run `node scripts/migrate-llm-wiki.js` in your wiki root to migrate from the old layout.
- Old `.wiki/` directory is preserved as a forwarding marker (`.wiki/MIGRATED_TO_LLM_WIKI.md`).
- No data loss — all content is moved, nothing deleted.

## [0.6.0] - 2026-05-11

### Added
- **Phase 1 — Auto-recall** (PR #19 by @arjun-zosma): New `wiki_recall` tool for explicit searches. Extension now auto-searches wiki before every user turn via `before_agent_start` hook. Matching pages injected as "Relevant Wiki Knowledge" into system prompt. 8 new tests.
- **Phase 2 — Auto-capture** (PR #20 by @arjun-zosma): New `wiki_retro` tool for saving atomic insights from completed tasks. Creates source packets with manifest, extracted text, and source page. 4 new tests.
- **Phase 3 — MCP Server** (PR #21 by @arjun-zosma): Standalone MCP server using `@modelcontextprotocol/server` (v2 SDK) with stdio transport. Exposes 5 tools: wiki_recall, wiki_search, wiki_status, wiki_retro, wiki_capture_source. Cross-platform reach to Claude Code, Cursor, Windsurf.
- **12 extension tools** (up from 10): wiki_recall (auto at turn start) and wiki_retro (manual at task end)
- **SKILL.md**: Auto-Recall section, wiki_recall + wiki_retro tool docs, "Task → Capture → Retro" workflow

### Changed
- Extension registers 12 tools instead of 10
- Status bar now shows "12 tools, auto-recall active"

## [0.5.0] - 2026-05-11

### Added
- **Overhauled README**: npm downloads badge, slash commands table, guardrails section, skill behavior, vault layout, source packet format, integration flow, linking style guide
- **Better npm discoverability**: 19 keywords (was 10), expanded description with search terms, `files` field to slim package
- **GitHub topics**: pi, llm-wiki, knowledge-base, wiki, markdown, obsidian, karpathy, second-brain, pkm, memory

## [0.4.0] - 2026-05-11

- JSON file support (PR #15 by jfraser)
- Extractor strategy pattern refactor

## [0.3.0] - 2026-05-07

- Release

## [0.2.2] - 2026-05-03

- Fix: CodeQL alerts for safe tag stripping and entity decoding
- Fix: README contributors via contrib.rocks
- Added: Features section and env var documentation

## [0.2.1] - 2026-04-29

- Minor fixes

## [0.2.0] - 2026-04-28

### Added

- **4-layer architecture**: raw/, wiki/, meta/, .wiki/ with explicit ownership rules
- **Source packets**: Structured capture with manifest.json, original/, extracted.md, attachments/
- **10 custom tools** (up from 5): wiki_bootstrap, wiki_capture_source, wiki_ingest, wiki_ensure_page, wiki_search, wiki_lint, wiki_status, wiki_rebuild_meta, wiki_log_event, wiki_watch
- **Auto-generated metadata**: registry.json, backlinks.json, index.md, log.md, events.jsonl
- **Guardrails**: Extension blocks direct edits to raw/** and meta/** via tool_call hook
- **Auto-rebuild**: Metadata rebuilds automatically after wiki/\*\* edits via turn_end hook
- **Batch ingest**: wiki_ingest returns source batches with extracted content previews
- **Improved lint**: Orphans, missing pages, contradictions, knowledge gaps with auto_fix option
- **Release scripts**: Automated semver bumping, changelog updates, git tagging
- **Coverage reporting**: v8 coverage in CI with lcov output

### Changed

- Extension moved from single file to modular directory structure (extensions/llm-wiki/)
- Skill reduced from ~500 lines to ~150 lines — principles over mechanics
- Metadata is now machine-owned; LLM never edits INDEX.md or LOG.md manually
- Source IDs use stable format SRC-YYYY-MM-DD-NNN for rename-safe citations

### Removed

- Manual INDEX.md/LOG.md maintenance from skill workflows
- Legacy flat raw/articles/ structure (replaced by structured source packets)
