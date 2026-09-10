# QMD Retrieval Phase 2 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:executing-plans` to implement this plan task-by-task. Track progress with the checkboxes below. Do not start Phase 3 until every required gate passes.

**Goal:** Close the crash-recovery, status-integrity, generated-state cleanup, configuration-safety, accounting, and operator-guidance gaps found in the completed Phase 2 implementation.

**Architecture:** Keep authoritative Markdown and existing recall unchanged. Make the QMD directory swap a write-ahead, state-verifiable operation shared by normal reindexing and fail-closed invalidation. Treat generated status as a strict parser over independent artifacts rather than conflating missing, malformed, and unreadable files. Clean only recognizable extension-owned staging artifacts while holding the existing per-vault lock. Preserve existing QMD SDK isolation and public tool shape.

**Tech Stack:** TypeScript 5.9, Node.js 22 `node:fs/promises`, `@tobilu/qmd` 2.5.3 public SDK, TypeBox, Vitest, Biome, pnpm.

**Normative inputs:**

- `docs/superpowers/specs/2026-08-08-qmd-retrieval-design.md`
- `docs/superpowers/plans/2026-08-09-qmd-retrieval-phase-2-validated-indexing.md`
- Audit range: `32b7983..2ff868c`

**Phase:** Phase 2 remediation. Phase 3 remains blocked until this plan passes.

---

## Baseline and Reviewed Defect Disposition

Baseline verified before this plan:

```text
Focused QMD suite: 43 passed, 1 model smoke skipped
Full suite:        654 passed, 1 model smoke skipped
Typecheck:         pass
Biome lint:        pass
MCP build:         pass
Retrieval baseline: unchanged from Phase 1
Mechanical scope:  recall.ts and inject.ts unchanged; QMD import isolated to qmd-store.ts
Known test noise:  okf-integration may print a background QMD recovery ENOENT during teardown
```

| Audit finding | Classification | Planned fix |
|---|---|---|
| Crash after `current → previous` but before journal update can leave no `current` | Critical implementation defect | Task 1 |
| Normal and fail-closed promotion duplicate the same unsafe ordering | Root-cause duplication | Task 1 |
| Malformed manifest/state can report `missing` or `ready` | Important implementation defect | Task 2 |
| `last-error.json` without a usable current reports `missing` | Important implementation defect | Task 2 |
| State file can report `ready` while `current/index.sqlite` is absent | Important implementation defect | Task 2 |
| Status cannot express which component needs repair | Operator-contract defect | Tasks 2 and 4 |
| Pre-journal failures leave full staging copies behind | Important generated-state lifecycle defect | Task 3 |
| Existing unreferenced staging directories are never reconciled | Important generated-state lifecycle defect | Task 3 |
| `ensureVaultId` treats malformed/unreadable config as `{}` and may overwrite it | Important data-safety defect | Task 3 |
| `scope="all"` omits unchanged rewritten pages from counts | Reporting defect | Task 4 |
| Lint can emit invalid `components=["lexical, vectors"]` | Operator-guidance defect | Task 4 |
| Existing vector index can cause stale vectors to receive lexical-only guidance | Operator-guidance defect | Task 4 |
| Integration test deletes a vault before fire-and-forget recovery drains | Test isolation defect | Task 4 |
| Real model-backed vector smoke remains unrun | Optional verification gap | Task 5 |

---

## Scope Boundaries

This remediation must not:

- change heuristic recall ranking, rendering, or `before_agent_start` injection;
- add Phase 3 lexical, hybrid, adaptive, quality, fallback, or cutover behavior;
- change QMD tables or import QMD outside `extensions/llm-wiki/lib/qmd-store.ts`;
- delete unknown entries under `.llm-wiki/meta/qmd/**`;
- break another host's or a malformed owner lock;
- load or download models during ordinary tests, status, lint, recovery, or lexical indexing;
- replace an invalid existing `vault_id` or reconstruct malformed configuration;
- change `wiki_reindex` input parameters.

A failed or cancelled operation must retain or restore the last usable current store. If no prior current exists, failure may leave the index missing, but never falsely ready. This plan covers process termination and interrupted filesystem operations using atomic file/directory replacement; fsync-level sudden-power-loss durability remains outside the existing Phase 2 contract.

---

## File Responsibility Map

### Production files

- `extensions/llm-wiki/lib/qmd-indexing.ts` — write-ahead promotion, state-aware recovery, strict status, fail-closed config parsing, staging cleanup, component repair metadata.
- `extensions/llm-wiki/lib/qmd-mirror.ts` — strict manifest read behavior and accurate full-scope counts.
- `extensions/llm-wiki/lib/wiki-service.ts` — complete blocked-reindex status objects after adding required repair metadata.
- `extensions/llm-wiki/lib/tools.ts` — exact component-specific lint repair commands.

### Tests

- `test/qmd-indexing-recovery.test.ts` — rename/journal crash windows and orphan recovery.
- `test/qmd-indexing.test.ts` — malformed state/config, missing current DB, last-error precedence, staging cleanup, component repair metadata.
- `test/qmd-mirror.test.ts` — malformed manifest and `scope="all"` accounting.
- `test/lint-okf.test.ts` — exact valid lexical/vector repair commands.
- `test/okf-integration.test.ts` — drain startup recovery before teardown.

### Documentation

- `docs/api.md` — strict status meanings and component-specific repair metadata/guidance.
- `docs/architecture.md` — write-ahead swap and generated staging cleanup semantics.
- `docs/commands.md` — valid repair examples.

No new production module is planned. Extract only one small shared promotion helper inside `qmd-indexing.ts`; both existing promotion paths must use it.

---

## Task 1: Make Store Promotion Crash-Safe Once

**Files:**

- Modify: `extensions/llm-wiki/lib/qmd-indexing.ts`
- Modify: `test/qmd-indexing-recovery.test.ts`
- Modify: `test/qmd-indexing.test.ts`

- [ ] **Step 1: Add failing tests for the uncovered crash windows**

Add on-disk recovery cases for:

1. journal says `prepared`, `current` is absent, `previous` exists, and staging exists — equivalent to a crash after moving current but before publishing `previous-moved`; recovery restores `previous` to `current`;
2. journal says `previous-moved`, both `current` and `previous` exist, and staging is absent — equivalent to a crash after promotion but before publishing `current-promoted`; recovery validates current and removes previous, or rolls back when current validation fails;
3. journal says `current-promoted`, current is absent, previous exists, and staging exists — recovery restores previous and removes staging;
4. no prior current, journal says `current-promoted`, promoted current is invalid, and no previous exists — recovery removes invalid generated current and reports a missing/error state rather than inventing a store;
5. write-ahead journal says `previous-moved`, but the crash occurred before `rename(current, previous)` — current and staging exist, previous does not; recovery keeps old current and removes staging;
6. write-ahead journal says `current-promoted`, and the crash occurred after `rename(staging, current)` but before `validated` — current and previous exist, staging does not; recovery validates current before choosing it over previous;
7. successful recovery to a validated current removes an earlier `last-error.json`, while recovery with no validated current preserves it.

Use the existing fake store factory and real temporary directories. Include a promoted store that opens successfully but reports the wrong document count; recovery must roll it back rather than treating mere openability as validity. Do not mock QMD internals.

- [ ] **Step 2: Assert write-ahead ordering during real promotion**

Wrap the existing injected filesystem adapter. Immediately before delegating each destructive rename, read `swap.json` and assert:

```text
rename(current, previous) -> persisted phase is previous-moved
rename(staging, current)  -> persisted phase is current-promoted
```

The phase is durable intent: it must be published before the corresponding rename. A failed rename therefore leaves recovery enough information to choose cleanup or rollback.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
pnpm exec vitest run test/qmd-indexing-recovery.test.ts --reporter=verbose
```

Expected: at least the current-to-previous crash-window test fails against `2ff868c`.

- [ ] **Step 4: Extract one shared promotion helper**

Inside `qmd-indexing.ts`, replace the duplicated rename/journal sequences in `reindexQmdVault` and `invalidateQmdAfterProjectionFailure` with one private helper. It must:

1. publish `prepared` after staging is closed and validated;
2. if current exists, publish `previous-moved` before moving current to previous;
3. publish `current-promoted` before moving staging to current;
4. reopen and validate promoted current as openable **and** require `status().totalDocuments` to equal the validated manifest entry count; if the manifest is unavailable during recovery, use the structurally valid `current/index-state.json` recorded count as the fallback expectation;
5. publish `validated` only after count validation succeeds;
6. remove previous and journal only after `validated` is durable;
7. never rename a directory while its store handle is open.

Keep SQLite/WAL/SHM/native sidecars together by renaming only complete artifact directories.

- [ ] **Step 5: Make recovery phase-and-filesystem aware**

Recovery must handle both old post-operation journals and new write-ahead journals. For each phase, inspect the existence of current, previous, and the journal-referenced staging directory. Rules:

- a current is valid only when it opens and its document count equals the manifest entry count, falling back to the current state file's recorded count only when the manifest cannot be read;
- if current is absent or invalid and previous exists, restore previous;
- if current is valid and previous exists, retain current and remove previous;
- remove only the journal-referenced staging directory;
- never remove previous until current passes count validation;
- after recovery leaves a validated current, remove `last-error.json`; if no validated current remains, retain the error artifact;
- leave malformed journals untouched for inspection.

This preserves compatibility with interrupted stores produced before remediation and prevents an openable-but-incomplete promoted store from displacing the last known-good index.

- [ ] **Step 6: Run focused recovery and indexing tests**

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-indexing-recovery.test.ts test/qmd-indexing.test.ts --reporter=verbose
pnpm typecheck
```

Expected: every stable phase and every transition-window state recovers to a usable current or an explicit missing/error state.

- [ ] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-indexing.ts test/qmd-indexing-recovery.test.ts test/qmd-indexing.test.ts
git commit -m "fix: make QMD store promotion crash-safe"
```

---

## Task 2: Make Generated Status Strict and Actionable

**Files:**

- Modify: `extensions/llm-wiki/lib/qmd-indexing.ts`
- Modify: `extensions/llm-wiki/lib/qmd-mirror.ts`
- Modify: `extensions/llm-wiki/lib/wiki-service.ts`
- Modify: `test/qmd-indexing.test.ts`
- Modify: `test/qmd-mirror.test.ts`

- [ ] **Step 1: Add failing artifact-state matrix tests**

Cover these states without opening a QMD store or loading a model:

| Artifacts | Expected state |
|---|---|
| no manifest, state, DB, error, or journal | `missing` |
| malformed manifest JSON | `error` with `qmd_manifest_invalid` |
| structurally invalid manifest entry | `error` with `qmd_manifest_invalid` |
| malformed state JSON | `error` with `qmd_index_error` |
| state object missing required status/model/hash fields | `error` with `qmd_index_error` |
| valid state but missing manifest | `stale` with `qmd_index_stale` |
| valid state but missing config | `error` because vault identity cannot be confirmed |
| valid state but missing `current/index.sqlite` | `error` with `qmd_index_error` |
| `last-error.json` but no usable current | `error` with `qmd_index_error` |
| usable current plus last error | `stale`, preserving last usable counts |
| valid swap journal | `recovering` with its phase |
| malformed swap journal | `error` with `qmd_swap_interrupted` |
| manifest hash mismatch, no vector index | `stale`, repair component `lexical` |
| embedding model mismatch | `stale`, repair component `vectors` |
| manifest mismatch with an existing vector index | `stale`, repair component `vectors` because vector reindex refreshes documents first |
| QMD package or vault identity mismatch, no vector index | `stale`, repair component `lexical` |
| QMD package or vault identity mismatch with vector index | `stale`, repair component `vectors` |

Use a required explicit status field named `repairComponents: QmdComponent[]`. It is empty for `ready`, `missing`, and `recovering`; it contains only valid `lexical`/`vectors` values for stale/error states where reindex can repair the condition. For malformed/error states, use `vectors` when a prior state proves a vector index exists (one vector pass refreshes documents first); otherwise use `lexical`. Update every `QmdGeneratedStatus` constructor, including `blockedReindexResult` in `wiki-service.ts`.

- [ ] **Step 2: Add strict manifest tests**

`readQmdManifest` must distinguish absence from corruption:

- `ENOENT` returns an empty manifest for the expected vault;
- malformed JSON or other read failures throw `qmd_manifest_invalid`;
- each entry must have a safe deterministic key, matching vault ID, matching role/page ID, an absolute source path contained under authoritative `paths.wiki` (therefore under `paths.root` and outside `paths.qmd`), a non-empty type, and a lowercase 64-hex SHA-256 content hash;
- unsafe or inconsistent entries never become trusted prior state;
- when the projection-failure invalidation path encounters a corrupt manifest, fail closed in the removal direction: publish an empty validated manifest and remove only generated mirror entries that can be enumerated safely, so stale deleted-page candidates cannot survive silently.

Tests should mutate one field at a time and assert rejection. Add an invalidation regression for a corrupt prior manifest. Do not follow symlinks or read source content while merely parsing status.

- [ ] **Step 3: Run tests and verify failure**

```bash
pnpm exec vitest run test/qmd-indexing.test.ts test/qmd-mirror.test.ts --reporter=verbose
```

Expected: malformed state/manifest and missing-DB cases fail against current status handling.

- [ ] **Step 4: Separate missing, invalid, and readable JSON states**

Replace broad status-path catches with an internal discriminated read result:

```ts
type JsonArtifact<T> =
  | { kind: "missing" }
  | { kind: "valid"; value: T }
  | { kind: "invalid"; message: string };
```

Only `ENOENT` is `missing`. JSON parse failures, permission failures, directories at file paths, and invalid shapes are `invalid`. Keep permissive lock-owner parsing separate; malformed foreign locks must remain unbroken.

Validate the complete `QmdIndexStateFile` shape before reading nested fields. Verify `current/index.sqlite` exists before `ready` or `stale` can be returned. Status remains model-free and must not call `openQmdIndexStore`.

- [ ] **Step 5: Implement deterministic precedence and repair components**

Apply status precedence in this order:

1. valid interrupted journal → `recovering`;
2. malformed journal, manifest, existing config identity, state, or error artifact → `error`;
3. no state and no last error → `missing` (a valid legacy config with no `vault_id` remains backfillable, not invalid);
4. state exists but `current/index.sqlite` is absent → `error`;
5. no structurally usable current with last error → `error`;
6. usable current with missing manifest, model/version/vault mismatch, or last error → `stale`;
7. otherwise → `ready`.

An absent config beside an existing state is `error`, because the indexed vault identity cannot be confirmed. Collect all applicable safe issues, not only the first mismatch. Derive `repairComponents` from every applicable reason using the rules above. Never expose model-cache paths or authoritative absolute source paths in chat rendering.

- [ ] **Step 6: Run focused tests**

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-mirror.test.ts test/qmd-indexing.test.ts test/lint-okf.test.ts test/mcp-parity.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-indexing.ts extensions/llm-wiki/lib/qmd-mirror.ts extensions/llm-wiki/lib/wiki-service.ts test/qmd-indexing.test.ts test/qmd-mirror.test.ts
git commit -m "fix: report QMD artifact health strictly"
```

---

## Task 3: Fail Closed on Config and Reconcile Staging Artifacts

**Files:**

- Modify: `extensions/llm-wiki/lib/qmd-indexing.ts`
- Modify: `test/qmd-indexing.test.ts`
- Modify: `test/qmd-indexing-recovery.test.ts`

- [ ] **Step 1: Add failing configuration-preservation tests**

For malformed JSON and JSON arrays/null:

- `ensureVaultId` and `reindexQmdVault` return a structured error;
- the original config bytes remain unchanged;
- no `vault_id` is generated;
- no mirror, staging store, or current store is created.

Use a deterministic read-error case by placing a directory at `config.json`; assert it remains a directory and no generated indexing state appears. Do not depend on chmod behavior, which differs across CI platforms.

A valid object without `vault_id` is still backfilled once and preserves every unrelated key. A valid but invalid existing `vault_id` remains unchanged and errors as today.

- [ ] **Step 2: Add failing staging cleanup tests**

Cover:

1. store update failure before journal publication;
2. staging validation failure before journal publication;
3. cancellation triggered from an update progress callback;
4. startup recovery with multiple unreferenced `staging-<uuid>` directories and no journal;
5. recovery with a valid journal referencing one staging directory plus unrelated stale staging directories;
6. malformed journal, where no staging directory is removed;
7. arbitrary unknown files/directories under `meta/qmd`, which are never removed.

After recoverable cases, all unreferenced exact-pattern staging directories are gone. Current, manifest/documents, known state/error files, a valid journal-referenced staging artifact, and arbitrary unknown entries remain untouched.

- [ ] **Step 3: Run tests and verify failure**

```bash
pnpm exec vitest run test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts --reporter=verbose
```

- [ ] **Step 4: Parse configuration fail-closed**

`ensureVaultId` must read and parse `config.json` directly. Missing, unreadable, malformed, null, or array configuration is an error; it must never become `{}`. Atomic backfill occurs only after a valid object and absent `vault_id` are confirmed.

Preserve the existing UUID validation and atomic replacement. Do not add a UUID dependency.

- [ ] **Step 5: Clean staging safely under the existing lock**

Keep the active staging path available to `catch/finally`:

- before a journal is published, failure or cancellation removes that operation's staging directory;
- after a journal is published, leave state for the recovery routine;
- during recovery with no malformed journal, scan only direct children matching the exact `STAGING_NAME` pattern and remove those not referenced by the active journal;
- do not recurse into or delete arbitrary names;
- perform cleanup only while holding the per-vault lock.

Use `Dirent` checks so a matching symlink or non-directory is not followed. Cleanup failures become safe diagnostics; they must not delete current or hide the original indexing error.

- [ ] **Step 6: Run focused tests**

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts test/indexing.test.ts test/indexing-fail-closed.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-indexing.ts test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts
git commit -m "fix: preserve QMD config and clean staging"
```

---

## Task 4: Correct Counts, Repair Commands, and Test Teardown

**Files:**

- Modify: `extensions/llm-wiki/lib/qmd-mirror.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `test/qmd-mirror.test.ts`
- Modify: `test/lint-okf.test.ts`
- Modify: `test/okf-integration.test.ts`
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`
- Modify: `docs/commands.md`

- [ ] **Step 1: Add failing full-scope accounting test**

Run `reconcileQmdMirror(paths, vaultId, "all")` twice over unchanged content. The second result must count every accepted page as `unchanged` even though full scope rewrites it. Assert:

```ts
indexed + updated + unchanged === Object.keys(manifest.entries).length
```

`removed` remains independent because deleted prior entries are not in the final manifest.

- [ ] **Step 2: Add exact lint command tests**

Assert complete command fragments, not only the word `wiki_reindex`:

```text
wiki_reindex(scope="changed", components=["lexical"], vault="active")
wiki_reindex(scope="changed", components=["vectors"], vault="active")
```

Also assert lint never emits:

```text
components=["lexical, vectors"]
```

Cases:

- manifest stale without a vector index → lexical;
- embedding model mismatch → vectors;
- document change with an existing vector index → vectors, because vector selection performs document update first;
- malformed/error state with no safe component inference → lexical fallback.

Build arrays with `JSON.stringify(qmdStatus.repairComponents)`; do not hand-build comma-delimited strings.

- [ ] **Step 3: Reproduce and fix integration teardown noise**

First reproduce the existing ENOENT warning with the current harness and confirm it is emitted by the `index.ts` startup-recovery wrapper. Then spy on `console.warn`, emit `session_shutdown`, and await `registerBackgroundRuntime`'s existing drain handler before temporary-vault cleanup. Assert no QMD recovery warning. Do not silence production warnings globally or bypass the harness lifecycle.

- [ ] **Step 4: Implement minimal reporting fixes**

- Increment `unchanged` based on content identity even when `scope="all"` forces a rewrite.
- Render lint guidance from validated `repairComponents`.
- Keep `missing` informational.
- Keep lint read-only for QMD.

- [ ] **Step 5: Update operator documentation**

Document:

- journal phases are write-ahead intent and recovery also checks filesystem state;
- recognizable stale staging directories are extension-owned and cleaned while locked;
- malformed generated artifacts report `error`, not `missing`/`ready`;
- `repairComponents` contains valid tool component values;
- vectors refresh documents before embedding, so `components=["vectors"]` repairs stale vectors and their document index together;
- active recall is still heuristic until Phase 3.

- [ ] **Step 6: Run focused parity and documentation tests**

```bash
pnpm exec vitest run test/qmd-mirror.test.ts test/lint-okf.test.ts test/okf-integration.test.ts test/background-tools.test.ts test/mcp-parity.test.ts test/package-structure.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-mirror.ts extensions/llm-wiki/lib/tools.ts test/qmd-mirror.test.ts test/lint-okf.test.ts test/okf-integration.test.ts docs/api.md docs/architecture.md docs/commands.md
git commit -m "fix: make QMD diagnostics actionable"
```

---

## Task 5: Final Phase 2 Certification

**Files:**

- Modify only if verification exposes a remediation regression.

- [ ] **Step 1: Run the complete model-free Phase 2 suite**

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run \
  test/qmd-mirror.test.ts \
  test/qmd-contract.test.ts \
  test/qmd-indexing.test.ts \
  test/qmd-indexing-recovery.test.ts \
  test/qmd-reindex-tool.test.ts \
  test/lint-okf.test.ts \
  test/indexing.test.ts \
  test/indexing-fail-closed.test.ts \
  --reporter=verbose
```

Expected: all model-free tests pass; model smoke remains skipped.

- [ ] **Step 2: Run all required repository gates**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build:mcp
pnpm benchmark:retrieval
git diff --check 2ff868c..HEAD
git status --short
```

Expected:

- no unexpected stderr recovery warning;
- MCP still exposes seven tools;
- retrieval benchmark exactly matches the Phase 1 baseline;
- no whitespace errors;
- clean implementation tree after commits.

- [ ] **Step 3: Verify phase scope mechanically**

```bash
git diff 2ff868c..HEAD -- extensions/llm-wiki/lib/recall.ts extensions/llm-wiki/lib/inject.ts
git grep -n "@tobilu/qmd" -- extensions/llm-wiki | grep -v "lib/qmd-store.ts"
git diff --name-only 2ff868c..HEAD
```

Expected:

- no recall/injection diff;
- no production QMD import outside `qmd-store.ts`;
- only files listed in this plan changed, unless a failing gate required a documented addition.

- [ ] **Step 4: Run optional real vector smoke**

Only when pinned models are already cached or the operator explicitly accepts the approximately 2 GB first-use download:

```bash
QMD_MODEL_SMOKE=1 QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts test/qmd-indexing.test.ts --reporter=verbose
```

Expected: embedding succeeds, vector status becomes fresh, and no query/reranking path is wired into recall.

If not run, record it as an explicit release-risk note rather than claiming model-backed verification.

- [ ] **Step 5: Inspect final history**

```bash
git log --oneline 2ff868c..HEAD
git diff --stat 2ff868c..HEAD
git diff --check 2ff868c..HEAD
git status --short
```

Expected: one reviewed planning commit plus four focused remediation commits after `2ff868c`, and a clean tree.

---

## Certification Criteria

Phase 2 is certified only when all statements are true:

- every destructive directory rename is preceded by durable journal intent;
- every journal phase recovers correctly across pre-operation and post-operation filesystem states;
- failed/cancelled pre-journal work leaves no staging copy;
- stale staging cleanup removes only exact extension-owned staging directories while locked;
- malformed or unreadable configuration is never overwritten;
- malformed generated artifacts and missing current DB cannot report `ready`;
- status supplies valid component-specific repair guidance;
- full-scope accounting includes every final manifest entry;
- Pi and MCP status/reindex parity remains green;
- current heuristic recall and Phase 1 retrieval metrics remain unchanged;
- all required model-free tests, typecheck, lint, MCP build, and diff checks pass;
- optional model smoke is either passed or explicitly recorded as unrun.

After certification, create the separate Phase 3 Retrieval Modes and Recall Cutover plan. Do not fold Phase 3 work into this remediation.
