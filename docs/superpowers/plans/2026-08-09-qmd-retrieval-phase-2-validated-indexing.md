# QMD Retrieval Phase 2: Validated Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build independently repairable per-vault QMD indexes from parser-valid Markdown, with validated canonical/evidence mirrors, incremental updates, deletion handling, vector indexing, status diagnostics, and crash-safe replacement, without changing active recall.

**Architecture:** Authoritative Markdown remains under `.llm-wiki/wiki/**`. A mirror module serializes only documents accepted by the shared parser into `.llm-wiki/meta/qmd/documents/{canonical,evidence}/**/*.md` and publishes a manifest that maps generated paths back to stable `(vault_id, page_id)` identities. A QMD-only adapter wraps the pinned public SDK, while an indexing coordinator serializes each vault through a filesystem lock, mutates a copied or fresh staging store, closes and validates it, and promotes the whole artifact directory through a recoverable journal. Normal metadata-triggered work updates lexical state without loading models; explicit `wiki_reindex` owns vector downloads and progress.

**Tech Stack:** TypeScript 5.9, Node.js 22 `node:fs/promises`, `node:crypto`, `@tobilu/qmd` 2.5.3 public SDK, TypeBox, Zod, Vitest.

**Roadmap:** `docs/superpowers/roadmaps/2026-08-09-qmd-retrieval-roadmap.md`

**Phase:** Phase 2: Validated QMD Indexing

---

## Phase Boundary

This plan starts from Phase 1's pinned QMD dependency and green SDK contract. It intentionally does **not**:

- change `extensions/llm-wiki/lib/recall.ts` ranking or result rendering;
- change automatic `before_agent_start` recall;
- add lexical, hybrid, adaptive, or quality query execution;
- add typed relation expansion, card/evidence bundles, conflict resolution, or feedback;
- deprecate `wiki_reindex_embeddings` yet; the roadmap assigns that compatibility step to Phase 3;
- edit QMD tables or import QMD internals.

At completion, existing heuristic recall and its page-level embedding sidecar remain active. QMD indexing is independently observable and repairable, but no recall path depends on it.

## Execution Prerequisites

1. Upstream Phase 1 PR `#144` must be merged, or the implementation branch must contain its exact commits.
2. Rebase the implementation branch onto current upstream `main` before changing production code.
3. Preserve the exact `@tobilu/qmd` `2.5.3` pin and Node.js `>=22.0.0` floor.
4. Run model-backed tests only with `QMD_MODEL_SMOKE=1`; ordinary tests must not download or load a model.

## File Map

### New production files

- `extensions/llm-wiki/lib/qmd-store.ts` — only production module allowed to import `@tobilu/qmd`; normalizes SDK update, embedding, status, model identity, and close behavior.
- `extensions/llm-wiki/lib/qmd-mirror.ts` — canonical/evidence role classification, manifest validation, deterministic hashing, parser-valid mirror reconciliation, and unsafe-entry invalidation.
- `extensions/llm-wiki/lib/qmd-indexing.ts` — stable vault ID backfill, per-vault locking, staging/copy-on-write indexing, journaled swap/recovery, reindex orchestration, cancellation, and generated status.

### New tests

- `test/qmd-mirror.test.ts` — valid/invalid/reserved page filtering, role mapping, manifest mapping, updates, role changes, and deletion.
- `test/qmd-indexing.test.ts` — real model-free QMD add/update/delete, vector delegation with a fake adapter, vault isolation, status, and forced rebuild.
- `test/qmd-indexing-recovery.test.ts` — every recoverable journal phase, failed reopen rollback, dead/live lock behavior, and no-rename-while-open contract.
- `test/qmd-reindex-tool.test.ts` — Pi tool validation, progress, cancellation, structured result, and no-model lexical path.

### Modified production files

- `extensions/llm-wiki/lib/utils.ts` — expose generated QMD paths on `VaultPaths`.
- `extensions/llm-wiki/lib/bootstrap.ts` — create and preserve stable `vault_id` values.
- `extensions/llm-wiki/lib/knowledge-document.ts` — add stable diagnostics for invalid vault IDs and QMD health.
- `extensions/llm-wiki/lib/indexing.ts` — schedule QMD only after successful metadata projection; on projection failure perform safety invalidation only.
- `extensions/llm-wiki/lib/wiki-service.ts` — shared vault selection, reindex operation, and QMD status shape.
- `extensions/llm-wiki/lib/tools.ts` — register `wiki_reindex`; include QMD state in `wiki_status` and `wiki_lint`; chain `wiki_rebuild_meta` into lexical QMD update.
- `extensions/llm-wiki/index.ts` — register `wiki_reindex` and run startup recovery without touching recall hooks.
- `mcp/operations.ts` — shared reindex and expanded status operations.
- `mcp/index.ts` — expose `wiki_reindex` and run startup recovery.

### Modified tests and docs

- `test/bootstrap.test.ts`, `test/mcp-parity.test.ts`, `test/mcp-package.test.ts`, `test/package-structure.test.ts`, `test/indexing.test.ts`, `test/indexing-fail-closed.test.ts`, `test/guardrails.test.ts`, and `test/background-tools.test.ts`.
- `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/commands.md`, and `skills/llm-wiki/SKILL.md`.

---

### Task 1: Stable Vault Identity and Generated Paths

**Files:**
- Modify: `extensions/llm-wiki/lib/utils.ts`
- Modify: `extensions/llm-wiki/lib/bootstrap.ts`
- Modify: `extensions/llm-wiki/lib/knowledge-document.ts`
- Modify: `test/bootstrap.test.ts`
- Modify: `test/mcp-parity.test.ts`

- [ ] **Step 1: Write failing vault-path and UUID tests**

Add assertions equivalent to:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

it("creates a stable vault_id and QMD paths", () => {
  const first = bootstrapVault(paths, { topic: "Identity", mode: "personal" });
  expect(first.ok).toBe(true);
  const firstConfig = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
  expect(firstConfig.vault_id).toMatch(UUID);

  bootstrapVault(paths, { topic: "Renamed", mode: "personal" });
  const secondConfig = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
  expect(secondConfig.vault_id).toBe(firstConfig.vault_id);

  expect(paths.qmd).toBe(join(paths.meta, "qmd"));
  expect(paths.qmdCurrent).toBe(join(paths.meta, "qmd", "current"));
  expect(paths.qmdDocuments).toBe(join(paths.meta, "qmd", "documents"));
  expect(paths.qmdManifest).toBe(join(paths.meta, "qmd", "manifest.json"));
  expect(paths.qmdSwap).toBe(join(paths.meta, "qmd", "swap.json"));
});
```

In MCP parity, stop comparing independently generated UUID values byte-for-byte. Assert that both are valid, then compare configs after omitting `vault_id`:

```ts
const { vault_id: mcpVaultId, ...mcpConfig } = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
const { vault_id: piVaultId, ...piConfig } = JSON.parse(readFileSync(piConfigPath, "utf8"));
expect(mcpVaultId).toMatch(UUID);
expect(piVaultId).toMatch(UUID);
expect(mcpConfig).toEqual(piConfig);
```

Do not install a UUID package; Node supplies `randomUUID()`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec vitest run test/bootstrap.test.ts test/mcp-parity.test.ts --reporter=verbose
```

Expected: failure because `vault_id` and QMD path fields do not exist.

- [ ] **Step 3: Extend `VaultPaths` in one place**

Add these required fields:

```ts
export interface VaultPaths {
  root: string;
  raw: string;
  rawSources: string;
  rawTrajectories: string;
  wiki: string;
  meta: string;
  dotWiki: string;
  outputs: string;
  discoveries: string;
  qmd: string;
  qmdCurrent: string;
  qmdDocuments: string;
  qmdManifest: string;
  qmdSwap: string;
}
```

Build them in both `getVaultPaths` and `getLegacyVaultPaths`. Use local `meta` and `qmd` constants so paths are not repeated inconsistently:

```ts
const meta = join(root, ".llm-wiki", "meta");
const qmd = join(meta, "qmd");
// ...existing fields...
qmd,
qmdCurrent: join(qmd, "current"),
qmdDocuments: join(qmd, "documents"),
qmdManifest: join(qmd, "manifest.json"),
qmdSwap: join(qmd, "swap.json"),
```

Do not create QMD directories from `ensureVaultStructure`; stores remain lazy.

- [ ] **Step 4: Create and preserve `vault_id` during bootstrap**

Import `randomUUID` from `node:crypto` and add:

```ts
const config: Record<string, unknown> = {
  ...existing,
  name: input.topic,
  mode: input.mode,
  topic: input.topic,
  created: existing.created ?? fmtDate(),
  version: existing.version ?? "1.0",
  vault_id: existing.vault_id ?? randomUUID(),
  ...(created ? { knowledge_format: "okf-0.2" } : {}),
};
```

An existing non-empty `vault_id` is preserved. Indexing validates it later and must never silently replace an invalid identity.

Add diagnostic codes now so later tasks do not use untyped strings:

```ts
| "config_invalid_vault_id"
| "qmd_index_missing"
| "qmd_index_stale"
| "qmd_index_error"
| "qmd_index_busy"
| "qmd_manifest_invalid"
| "qmd_swap_interrupted";
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec vitest run test/bootstrap.test.ts test/mcp-parity.test.ts --reporter=verbose
pnpm typecheck
```

Expected: all pass. Bootstrap reruns preserve page content and `vault_id`.

- [ ] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/utils.ts extensions/llm-wiki/lib/bootstrap.ts extensions/llm-wiki/lib/knowledge-document.ts test/bootstrap.test.ts test/mcp-parity.test.ts
git commit -m "feat: add stable wiki vault identities"
```

---

### Task 2: Parser-Validated Mirror and Manifest

**Files:**
- Create: `extensions/llm-wiki/lib/qmd-mirror.ts`
- Create: `test/qmd-mirror.test.ts`

- [ ] **Step 1: Write failing mirror contract tests**

Use a temporary vault under `node:os.tmpdir()`. Create these pages:

| Path | Type/content | Expected role |
|---|---|---|
| `concepts/card.md` | `type: concept` | canonical |
| `entities/person.md` | `type: entity` | canonical |
| `analyses/decision.md` | `type: analysis` | canonical |
| `syntheses/summary.md` | `type: synthesis` | canonical |
| `requirements/rule.md` | `type: requirement` | canonical |
| `skills/procedure.md` | `type: skill` | canonical |
| `cases/example.md` | `type: case` | canonical |
| `sources/source.md` | `type: source` | evidence |
| `misc/unknown.md` | `type: custom` | evidence |
| `concepts/bad.md` | malformed frontmatter | absent |
| `concepts/index.md` | reserved generated name | absent |
| `log.md` | reserved generated name | absent |

Use a concrete fixture so the engineer is never guessing content. For example, `concepts/card.md` is exactly:

```
---
type: concept
title: Retrieval Card
created: 2026-08-09
updated: 2026-08-09
---

# Retrieval Card

QMD mirrors only parser-valid Markdown.
```

And `concepts/bad.md` is exactly:

```
this file has no frontmatter at all
```

The core assertions must be:

```ts
const result = await reconcileQmdMirror(paths, vaultId, "changed");
expect(result.counts).toEqual({ indexed: 9, updated: 0, unchanged: 0, removed: 0 });
expect(result.diagnostics.map((d) => d.code)).toContain("frontmatter_missing");

const manifest = await readQmdManifest(paths, vaultId);
expect(Object.keys(manifest.entries).sort()).toEqual([
  "documents/canonical/analyses/decision.md",
  "documents/canonical/cases/example.md",
  "documents/canonical/concepts/card.md",
  "documents/canonical/entities/person.md",
  "documents/canonical/requirements/rule.md",
  "documents/canonical/skills/procedure.md",
  "documents/canonical/syntheses/summary.md",
  "documents/evidence/misc/unknown.md",
  "documents/evidence/sources/source.md",
]);
expect(manifest.entries["documents/canonical/concepts/card.md"]).toMatchObject({
  vaultId,
  pageId: "concepts/card",
  role: "canonical",
});
```

Add separate cases proving:

1. unchanged reconciliation does not rewrite mirror files and returns `unchanged`;
2. body edits return `updated` and change the SHA-256 hash;
3. changing `type: concept` to `type: source` removes the canonical path and creates the evidence path;
4. deleting a page removes its manifest entry and mirror file;
5. making a previously valid page malformed removes its old mirror entry;
6. invalid or mismatched manifest `vaultId` returns `qmd_manifest_invalid` and rebuilds from authoritative pages;
7. every manifest `sourcePath` is absolute and every manifest key uses `/`, including on Windows.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
pnpm exec vitest run test/qmd-mirror.test.ts --reporter=verbose
```

Expected: module-not-found failure for `qmd-mirror.js`.

- [ ] **Step 3: Define manifest and reconciliation types**

Create `qmd-mirror.ts` with no QMD import:

```ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { serializeKnowledgeDocument } from "./knowledge-document.js";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import type { VaultPaths } from "./utils.js";
import { discoverKnowledgeDocuments } from "./vault-format.js";

export const QMD_MANIFEST_VERSION = 1;
export type QmdRole = "canonical" | "evidence";

export interface QmdManifestEntry {
  sourcePath: string;
  vaultId: string;
  pageId: string;
  contentHash: string;
  role: QmdRole;
  type: string;
}

export interface QmdManifest {
  version: 1;
  vaultId: string;
  entries: Record<string, QmdManifestEntry>;
}

export interface QmdMirrorCounts {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface QmdMirrorResult {
  manifest: QmdManifest;
  manifestHash: string;
  counts: QmdMirrorCounts;
  diagnostics: KnowledgeDiagnostic[];
}

const CANONICAL_TYPES = new Set([
  "concept",
  "entity",
  "analysis",
  "synthesis",
  "requirement",
  "skill",
  "case",
]);
```

Export `roleForDocumentType(type: string): QmdRole`; normalize with `trim().toLowerCase()` and default unknown types to evidence. Also export `readQmdManifest(paths, expectedVaultId): Promise<QmdManifest>` for status and tests; it must reject malformed, wrong-version, wrong-vault, absolute-key, and traversal-key data rather than returning an untrusted partial manifest.

- [ ] **Step 4: Implement deterministic keys, hashes, and atomic writes**

Use these contracts:

```ts
export function manifestKey(role: QmdRole, pageId: string): string {
  return ["documents", role, ...pageId.split("/")].join("/") + ".md";
}

export function hashQmdContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashQmdManifest(manifest: QmdManifest): string {
  const entries = Object.fromEntries(
    Object.entries(manifest.entries).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return hashQmdContent(JSON.stringify({ version: manifest.version, vaultId: manifest.vaultId, entries }));
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}
```

Convert manifest keys to physical paths only through a containment-checked helper. Reject absolute keys, `..`, and any resolved path outside `paths.qmd`; never trust paths loaded from JSON.

- [ ] **Step 5: Implement fail-safe mirror publication**

`reconcileQmdMirror(paths, vaultId, scope)` must:

1. call `discoverKnowledgeDocuments(paths)` and retain its diagnostics even when discovery is blocking;
2. use only `discovery.documents`, which already passed the shared parser and reserved-name/symlink/collision checks;
3. serialize each accepted document with `serializeKnowledgeDocument`, hash that exact mirror string, and derive its role;
4. load a version- and UUID-validated prior manifest or use an empty manifest plus `qmd_manifest_invalid` diagnostic;
5. build the complete desired manifest in code-point key order;
6. atomically publish an intermediate manifest that removes deleted, malformed, or role-moved entries **before** changing files, ensuring future retrieval cannot map an unsafe old candidate;
7. atomically write new/changed mirror files; for `scope: "all"`, rewrite all accepted files; for `changed`, skip equal hashes;
8. atomically publish the final desired manifest;
9. remove orphaned generated mirror files and empty generated directories without following symlinks;
10. return exact indexed/updated/unchanged/removed counts and the stable entries-only manifest hash.

A mirror write failure must leave either the intermediate or previous valid manifest, never a manifest entry that points to missing or unvalidated content. Generated leftovers not referenced by the manifest are harmless and removed by the next reconciliation.

Also export:

```ts
export async function invalidateUnsafeQmdEntries(
  paths: VaultPaths,
  vaultId: string,
): Promise<QmdMirrorResult>;
```

It performs the same complete parser scan but may only remove manifest entries for missing or rejected pages. It must not add or update valid documents. This is the safety-only path used when metadata projection fails.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec vitest run test/qmd-mirror.test.ts test/knowledge-document.test.ts test/indexing-fail-closed.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

Expected: all pass; no model cache files are created.

- [ ] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-mirror.ts test/qmd-mirror.test.ts
git commit -m "feat: build validated QMD document mirrors"
```

---

### Task 3: Public-SDK QMD Store Adapter

**Files:**
- Create: `extensions/llm-wiki/lib/qmd-store.ts`
- Modify: `test/qmd-contract.test.ts`

- [ ] **Step 1: Add failing normalized-adapter tests**

Extend `test/qmd-contract.test.ts` to use canonical and evidence directories, then assert:

```ts
const handle = await openQmdIndexStore({
  dbPath,
  documentsPath,
});
const updated = await handle.update();
expect(updated).toEqual({
  collections: 2,
  indexed: 2,
  updated: 0,
  unchanged: 0,
  removed: 0,
  needsEmbedding: 2,
});
expect(await handle.status()).toMatchObject({
  totalDocuments: 2,
  needsEmbedding: 2,
  hasVectorIndex: false,
});
await handle.close();
```

Delete one evidence file, reopen, update, and expect `removed: 1`. Verify lexical update leaves QMD model cache contents unchanged.

- [ ] **Step 2: Run contract test and verify failure**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose
```

Expected: failure because normalized adapter does not exist.

- [ ] **Step 3: Define package-private normalized adapter**

`qmd-store.ts` is the only production file importing QMD:

```ts
import { createStore } from "@tobilu/qmd";
import type { QMDStore } from "@tobilu/qmd";
import { join } from "node:path";

export const QMD_PACKAGE_VERSION = "2.5.3";
export const QMD_DEFAULT_MODELS = {
  embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
  generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
  rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
} as const;

export interface QmdResolvedModels {
  embed: string;
  generate: string;
  rerank: string;
}

export interface QmdStoreUpdateResult {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  needsEmbedding: number;
}

export interface QmdStoreEmbedResult {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
}

export interface QmdStoreStatus {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  canonicalDocuments: number;
  evidenceDocuments: number;
}

export interface QmdIndexStore {
  update(onProgress?: (progress: { collection: string; file: string; current: number; total: number }) => void): Promise<QmdStoreUpdateResult>;
  embed(options: { force: boolean; onProgress?: (progress: { chunksEmbedded: number; totalChunks: number; errors: number }) => void }): Promise<QmdStoreEmbedResult>;
  status(): Promise<QmdStoreStatus>;
  close(): Promise<void>;
}

export type QmdStoreFactory = (input: {
  dbPath: string;
  documentsPath: string;
}) => Promise<QmdIndexStore>;
```

No `QMDStore`, `IndexStatus`, `UpdateResult`, or other package type may appear outside this file.

- [ ] **Step 4: Implement collection config and guaranteed close behavior**

Use exact non-overlapping collection paths:

```ts
export async function openQmdIndexStore(input: {
  dbPath: string;
  documentsPath: string;
}): Promise<QmdIndexStore> {
  const store: QMDStore = await createStore({
    dbPath: input.dbPath,
    config: {
      global_context: "Validated LLM Wiki knowledge",
      collections: {
        canonical: {
          path: join(input.documentsPath, "canonical"),
          pattern: "**/*.md",
          context: { "/": "Reusable conclusions, entities, requirements, and procedures" },
        },
        evidence: {
          path: join(input.documentsPath, "evidence"),
          pattern: "**/*.md",
          context: { "/": "Source evidence, observations, trajectories, and unpromoted notes" },
        },
      },
    },
  });

  return {
    update: (onProgress) => store.update({ onProgress }),
    embed: ({ force, onProgress }) =>
      store.embed({ force, chunkStrategy: "regex", onProgress }),
    status: async () => {
      const status = await store.getStatus();
      const counts = Object.fromEntries(status.collections.map((collection) => [collection.name, collection.documents]));
      return {
        totalDocuments: status.totalDocuments,
        needsEmbedding: status.needsEmbedding,
        hasVectorIndex: status.hasVectorIndex,
        canonicalDocuments: counts.canonical ?? 0,
        evidenceDocuments: counts.evidence ?? 0,
      };
    },
    close: () => store.close(),
  };
}
```

QMD 2.5.3 omits empty collections from `getStatus().collections`; default absent counts to zero. Never inspect `store.internal` or QMD SQLite tables.

Resolve model identities without loading models:

```ts
export function resolveQmdModels(env: NodeJS.ProcessEnv = process.env): QmdResolvedModels {
  return {
    embed: env.QMD_EMBED_MODEL?.trim() || QMD_DEFAULT_MODELS.embed,
    generate: env.QMD_GENERATE_MODEL?.trim() || QMD_DEFAULT_MODELS.generate,
    rerank: env.QMD_RERANK_MODEL?.trim() || QMD_DEFAULT_MODELS.rerank,
  };
}
```

- [ ] **Step 5: Run model-free SDK tests**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

Expected: lexical tests pass, model smoke remains skipped, and cache file listing is unchanged.

- [ ] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-store.ts test/qmd-contract.test.ts
git commit -m "feat: add QMD index store adapter"
```

---

### Task 4: Copy-on-Write Indexing, Locking, Swap, and Recovery

**Files:**
- Create: `extensions/llm-wiki/lib/qmd-indexing.ts`
- Create: `test/qmd-indexing.test.ts`
- Create: `test/qmd-indexing-recovery.test.ts`

- [ ] **Step 1: Write failing model-free indexing tests**

Use real QMD with `components: ["lexical"]` and temporary vaults. Cover:

```ts
const first = await reindexQmdVault(paths, {
  scope: "changed",
  components: ["lexical"],
  force: false,
});
expect(first.ok).toBe(true);
expect(first.documents).toMatchObject({ indexed: 2, removed: 0 });
expect(first.vectors.generated).toBe(0);
expect(first.status.state).toBe("ready");
expect(existsSync(join(paths.qmdCurrent, "index.sqlite"))).toBe(true);

// edit, add, delete, then run changed again
expect(second.documents).toMatchObject({ indexed: 1, updated: 1, removed: 1 });
expect(second.status.totalDocuments).toBe(2);
```

Also assert:

- `components: ["vectors"]` still performs document update before calling fake adapter `embed`;
- `force: true` with lexical starts from an empty staging store instead of copying current;
- `force: true` with vectors passes `force: true` to `embed`;
- lexical-only indexing never calls `embed`;
- identical page IDs in two vaults produce different `vaultId` values and independent stores;
- invalid existing `vault_id` returns `config_invalid_vault_id` without replacing it;
- a pre-QMD existing config receives one UUID backfill while every unrelated key remains byte-for-byte equivalent as parsed JSON;
- failed staging update leaves current store and `index-state.json` unchanged while status becomes stale/error with the failed manifest hash recorded.

- [ ] **Step 2: Write failing recovery-state tests**

Construct generated directories and `swap.json` directly; no production fault-injection option is needed. Cover each journal phase:

| Phase | Disk state | Recovery result |
|---|---|---|
| `prepared` | current + staging | remove staging, retain current |
| `previous-moved` | previous + staging, no current | restore previous to current, remove staging |
| `current-promoted` valid | current + previous | validate current, remove previous |
| `current-promoted` invalid | broken current + previous | remove broken generated current, restore previous |
| `validated` | current + previous | retain current, remove previous |
| malformed journal | current present | retain current, report `qmd_swap_interrupted`; do not guess destructive recovery |

Use a fake adapter that tracks `open` and `close`. Assert every `rename` recorded by an injected filesystem test seam occurs only when open-handle count is zero.

Add lock cases:

- live same-host PID returns `qmd_index_busy`;
- dead same-host PID lock is recovered;
- other-host or malformed lock is never broken automatically;
- lock is removed in `finally` after update, embed, validation, cancellation, and thrown errors.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts --reporter=verbose
```

Expected: module-not-found failure for `qmd-indexing.js`.

- [ ] **Step 4: Define public reindex, state, journal, and status contracts**

Create these normalized contracts in `qmd-indexing.ts`:

```ts
export type QmdComponent = "lexical" | "vectors";
export type QmdReindexScope = "changed" | "all";
export type QmdIndexState = "missing" | "ready" | "stale" | "recovering" | "error";

export interface QmdReindexOptions {
  scope: QmdReindexScope;
  components: QmdComponent[];
  force: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: QmdIndexProgress) => void;
}

export interface QmdIndexProgress {
  stage: "mirror" | "copy" | "lexical" | "vectors" | "validate" | "swap";
  message: string;
  current?: number;
  total?: number;
}

export interface QmdIndexIssue {
  code: string;
  message: string;
  path?: string;
}

export interface QmdGeneratedStatus {
  state: QmdIndexState;
  vaultId?: string;
  qmdVersion: string;
  models: QmdResolvedModels;
  totalDocuments: number;
  canonicalDocuments: number;
  evidenceDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  manifestHash?: string;
  indexedManifestHash?: string;
  lastIndexedAt?: string;
  swapPhase?: QmdSwapPhase;
  issues: QmdIndexIssue[];
}

export interface QmdReindexResult {
  ok: boolean;
  vaultId?: string;
  scope: QmdReindexScope;
  components: QmdComponent[];
  documents: { indexed: number; updated: number; unchanged: number; removed: number };
  vectors: { generated: number; skipped: number; errors: number };
  elapsedMs: number;
  status: QmdGeneratedStatus;
  warnings: QmdIndexIssue[];
  errors: QmdIndexIssue[];
}

export type QmdSwapPhase = "prepared" | "previous-moved" | "current-promoted" | "validated";

interface QmdSwapJournal {
  version: 1;
  operationId: string;
  stagingName: string;
  phase: QmdSwapPhase;
  startedAt: string;
}

interface QmdIndexStateFile {
  version: 1;
  vaultId: string;
  qmdVersion: string;
  models: QmdResolvedModels;
  manifestHash: string;
  indexedAt: string;
  status: QmdStoreStatus;
}
```

`components` must be de-duplicated and non-empty. Check `signal.aborted` before each stage and in every QMD progress callback; throw a private `QmdIndexCancelledError` so cancellation never promotes staging. Map vector counts without guessing: `generated` is `embedResult.docsProcessed`, `errors` is `embedResult.errors`, and `skipped` is `Math.max(0, storeStatus.totalDocuments - embedResult.docsProcessed)` when vectors are selected (otherwise all three are zero).

- [ ] **Step 5: Implement stable existing-vault ID backfill**

Under the QMD lock, read `config.json` as an object. Use Node's `randomUUID` and `UUID` validation matching Task 1:

```ts
export async function ensureVaultId(paths: VaultPaths): Promise<string> {
  const configPath = join(paths.dotWiki, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  if (typeof config.vault_id === "string") {
    if (!UUID.test(config.vault_id)) throw new QmdIndexError("config_invalid_vault_id", "config.json contains an invalid vault_id");
    return config.vault_id;
  }
  if (config.vault_id !== undefined) {
    throw new QmdIndexError("config_invalid_vault_id", "config.json contains a non-string vault_id");
  }
  const vaultId = randomUUID();
  await atomicWriteJson(configPath, { ...config, vault_id: vaultId });
  return vaultId;
}
```

Do not rewrite a valid ID and do not replace an invalid ID.

- [ ] **Step 6: Implement cross-process index lock**

Use atomic directory creation at `meta/qmd/index.lock`, with `owner.json` containing `{ pid, hostname, acquiredAt }`.

```ts
async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
```

On `EEXIST`, recover only if owner JSON is valid, hostname equals `node:os.hostname()`, and the PID is no longer alive. Never use an age-only timeout: vector indexing can legitimately run for minutes. Other-host, malformed, or live locks return `qmd_index_busy`. Always remove a lock acquired by this process in `finally`.

Keep one in-process promise queue per physical `paths.root` in addition to the lock, so calls from the same extension do not race or spuriously report busy.

- [ ] **Step 7: Implement staging and promotion**

For every mutation, including ordinary changed indexing:

1. recover an interrupted prior swap;
2. reconcile mirror (`all` rewrites accepted files, `changed` hashes and skips);
3. create `staging-<randomUUID>` under `paths.qmd`;
4. if lexical is not forced and current exists, recursively `cp(paths.qmdCurrent, staging, { recursive: true, errorOnExist: true })`; otherwise create empty staging;
5. open only `staging/index.sqlite` using `openQmdIndexStore` and the committed `paths.qmdDocuments`;
6. call `update` whenever lexical or vectors are selected; vectors require fresh document state;
7. call `embed({ force })` only when vectors are selected;
8. call `status`, require `totalDocuments === Object.keys(manifest.entries).length`, then close in `finally`;
9. write `index-state.json` inside staging after close;
10. reopen staging, validate status/counts again, and close before any rename;
11. atomically write journal phase `prepared`;
12. remove only a stale generated `previous` already proven safe by recovery;
13. rename current to fixed `previous` when current exists, then journal `previous-moved`;
14. rename staging to current, then journal `current-promoted`;
15. reopen current, validate state/counts, close, then journal `validated`;
16. remove previous and journal.

Use one helper to open, run, and close so all paths release QMD resources:

```ts
async function withStore<T>(
  factory: QmdStoreFactory,
  input: { dbPath: string; documentsPath: string },
  work: (store: QmdIndexStore) => Promise<T>,
): Promise<T> {
  const store = await factory(input);
  try {
    return await work(store);
  } finally {
    await store.close();
  }
}
```

No rename may run inside `work` or before `withStore` resolves.

- [ ] **Step 8: Implement deterministic recovery**

Expose the single injection seam used by recovery/indexing tests so they never touch QMD globals or real handles:

```ts
export interface QmdIndexDeps {
  factory: QmdStoreFactory;
  fs?: {
    exists(path: string): Promise<boolean>;
    rename(from: string, to: string): Promise<void>;
    rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
    cp(from: string, to: string, options: { recursive: boolean; errorOnExist: boolean }): Promise<void>;
  };
}
```

`reindexQmdVault` and `recoverQmdIndex` accept optional `deps?: Partial<QmdIndexDeps>` and default to real `node:fs/promises`. Recovery tests use `deps` for the open-handle assertion: the fake `fs.rename` throws if the fake factory reports any store still open. The wrapper factory in `deps.factory` increments a counter on open and decrements on close, so every rename is provably closed-store-only.

`recoverQmdIndex(paths, deps?)` must acquire the same lock and validate journal names as basenames matching `staging-<uuid>`. Never use absolute or parent-relative paths from journal JSON.

Recovery behavior:

```ts
switch (journal.phase) {
  case "prepared":
    await rm(staging, { recursive: true, force: true });
    break;
  case "previous-moved":
    if (!(await pathExists(current)) && (await pathExists(previous))) {
      await rename(previous, current);
    }
    await rm(staging, { recursive: true, force: true });
    break;
  case "current-promoted":
    if (await validateCurrent(paths, factory)) {
      await rm(previous, { recursive: true, force: true });
    } else if (await pathExists(previous)) {
      await rm(current, { recursive: true, force: true });
      await rename(previous, current);
    } else {
      await rm(current, { recursive: true, force: true });
    }
    break;
  case "validated":
    await rm(previous, { recursive: true, force: true });
    break;
}
await rm(paths.qmdSwap, { force: true });
```

Before cleanup in `current-promoted`, close validation store. A malformed journal produces a diagnostic and leaves current/previous/staging untouched for human inspection.

- [ ] **Step 9: Implement generated status without opening QMD**

`readQmdIndexStatus(paths)` reads only manifest, `current/index-state.json`, optional `last-error.json`, lock, and swap journal. State rules:

1. `recovering` when a valid swap journal exists;
2. `missing` when current state is absent;
3. `error` for invalid manifest/state or recorded last error with no usable current;
4. `stale` when manifest hash, QMD package version, vault ID, or resolved embedding model differs from indexed state, or last error exists beside a usable current;
5. `ready` otherwise.

Generation/rerank model changes are reported but do not invalidate lexical/vector index content. Embedding model mismatch marks vectors stale. Clear `last-error.json` only after successful promotion. Record errors atomically without deleting current.

- [ ] **Step 10: Run focused indexing and recovery tests**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts test/qmd-contract.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

Expected: all model-free tests pass; model smoke skipped; failed and cancelled updates retain current.

- [ ] **Step 11: Commit**

```bash
git add extensions/llm-wiki/lib/qmd-indexing.ts test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts
git commit -m "feat: add recoverable QMD index lifecycle"
```

---

### Task 5: Shared `wiki_reindex` for Pi and MCP

**Files:**
- Modify: `extensions/llm-wiki/lib/wiki-service.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `extensions/llm-wiki/index.ts`
- Modify: `mcp/operations.ts`
- Modify: `mcp/index.ts`
- Create: `test/qmd-reindex-tool.test.ts`
- Modify: `test/mcp-parity.test.ts`
- Modify: `test/mcp-package.test.ts`
- Modify: `test/package-structure.test.ts`

- [ ] **Step 1: Write failing shared-operation and tool tests**

Capture the Pi tool registration and assert exact schema behavior:

```ts
expect(tool.name).toBe("wiki_reindex");
const result = await tool.execute(
  "id",
  { scope: "changed", components: ["lexical"], force: false, vault: "active" },
  new AbortController().signal,
  onUpdate,
  ctx,
);
expect(result.isError).not.toBe(true);
expect(result.details).toMatchObject({
  scope: "changed",
  components: ["lexical"],
  vault: "active",
});
expect(result.content[0].text).toContain("QMD indexing complete");
```

Test validation for empty components, unavailable `project` scope from a personal vault, and invalid writable-vault config. Abort before start and expect structured cancellation without current-store deletion.

For vault selection, assert:

- `active` processes only resolved active paths;
- `personal` processes only `getPersonalWikiPaths()`;
- `project` processes only active non-personal paths;
- `all` processes project and personal independently, deduplicating identical roots;
- one vault failure does not prevent the other result from being returned.

Update MCP parity to expect a seventh tool and compare the normalized `reindexWiki` result with `reindexOperation` using lexical-only temporary vaults.

Update packaged MCP test title and expected tool list, then invoke:

```json
{
  "name": "wiki_reindex",
  "arguments": {
    "scope": "changed",
    "components": ["lexical"],
    "force": false,
    "vault": "active"
  }
}
```

Assert success and `.llm-wiki/meta/qmd/current/index.sqlite` existence.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec vitest run test/qmd-reindex-tool.test.ts test/mcp-parity.test.ts test/mcp-package.test.ts test/package-structure.test.ts --reporter=verbose
```

Expected: missing operation/tool and six-vs-seven registration failures.

- [ ] **Step 3: Add shared vault selection and operation**

In `wiki-service.ts`, add:

```ts
export type WikiReindexVault = "active" | "personal" | "project" | "all";

export interface WikiReindexInput {
  scope?: "changed" | "all";
  components?: Array<"lexical" | "vectors">;
  force?: boolean;
  vault?: WikiReindexVault;
  signal?: AbortSignal;
  onProgress?: (progress: { vault: string; progress: QmdIndexProgress }) => void;
}

export interface WikiReindexResult {
  vault: WikiReindexVault;
  results: Array<{ root: string; label: "active" | "personal" | "project"; result: QmdReindexResult }>;
}
```

`reindexWiki(activePaths, input)` validates defaults exactly:

```ts
scope: input.scope ?? "changed"
components: input.components ?? ["lexical", "vectors"]
force: input.force ?? false
vault: input.vault ?? "active"
```

Process selected vaults sequentially. Sequential execution avoids simultaneous model loads and gives deterministic progress/result order. Validate each vault with `inspectWritableVault` immediately before work.

- [ ] **Step 4: Register Pi tool**

Add `registerWikiReindex` in `tools.ts` with all required extension-tool fields:

```ts
parameters: Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal("changed"), Type.Literal("all")], { default: "changed" })),
  components: Type.Optional(Type.Array(
    Type.Union([Type.Literal("lexical"), Type.Literal("vectors")]),
    { minItems: 1, uniqueItems: true, default: ["lexical", "vectors"] },
  )),
  force: Type.Optional(Type.Boolean({ default: false })),
  vault: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("personal"),
    Type.Literal("project"),
    Type.Literal("all"),
  ], { default: "active" })),
}),
```

Use the tool's `signal`. Forward progress through `_onUpdate` as a short text block plus structured details. This explicit repair command runs foreground so cancellation remains connected; do not dispatch it through `Runtime.launchTask`.

Return the complete shared result in `details`. Selecting only lexical must say `model-free lexical indexing`; selecting vectors must warn before work that QMD may download approximately 2 GB of models on first use.

Register it in `extensions/llm-wiki/index.ts`. Update the entry comment from 13 to 14 standard tools.

- [ ] **Step 5: Add MCP operation and tool**

`mcp/operations.ts` adds a thin `reindexOperation(paths, input)` that returns `reindexWiki(paths, input)` with no duplicate indexing logic.

Register `wiki_reindex` in `mcp/index.ts` using Zod enums and a non-empty components array. Pass MCP cancellation signal when available. Return shared result as JSON. Update the module comment that describes the other tools as “the other five” to say “the other tools”.

- [ ] **Step 6: Update package structure and parity expectations**

Add `registerWikiReindex` to the production-registration assertion. Change MCP lists to exactly:

```ts
[
  "wiki_bootstrap",
  "wiki_recall",
  "wiki_search",
  "wiki_status",
  "wiki_reindex",
  "wiki_retro",
  "wiki_capture_source",
]
```

Use sorted order where the test already sorts.

- [ ] **Step 7: Run Pi/MCP tests and package build**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-reindex-tool.test.ts test/mcp-parity.test.ts test/mcp-package.test.ts test/package-structure.test.ts --reporter=verbose
pnpm build:mcp
pnpm typecheck
pnpm lint
```

Expected: seven MCP tools; lexical reindex succeeds without model download.

- [ ] **Step 8: Commit**

```bash
git add extensions/llm-wiki/lib/wiki-service.ts extensions/llm-wiki/lib/tools.ts extensions/llm-wiki/index.ts mcp/operations.ts mcp/index.ts test/qmd-reindex-tool.test.ts test/mcp-parity.test.ts test/mcp-package.test.ts test/package-structure.test.ts
git commit -m "feat: expose shared QMD reindex operation"
```

---

### Task 6: Post-Projection Scheduling and Startup Recovery

**Files:**
- Modify: `extensions/llm-wiki/lib/indexing.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `extensions/llm-wiki/index.ts`
- Modify: `mcp/operations.ts`
- Modify: `mcp/index.ts`
- Modify: `test/indexing.test.ts`
- Modify: `test/indexing-fail-closed.test.ts`
- Modify: `test/background-tools.test.ts`
- Modify: `test/guardrails.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Mock only `qmd-indexing.js`, not QMD. Extend indexing tests to prove:

```ts
expect(reindexQmdVault).toHaveBeenCalledWith(paths, expect.objectContaining({
  scope: "changed",
  components: ["lexical"],
  force: false,
}));
```

Required cases:

1. successful metadata projection schedules exactly one coalesced lexical QMD pass;
2. no automatic vector call occurs;
3. writes arriving during QMD work cause one trailing pass and are not lost;
4. QMD failure does not reject the page write or skip the legacy embedding refresh;
5. blocking metadata projection does **not** call full reconciliation or index valid additions;
6. blocking projection calls only unsafe-entry invalidation and then a lexical removal update when entries were removed;
7. `wiki_rebuild_meta` awaits lexical QMD indexing only after successful projection and reports QMD failure as a warning;
8. direct writes under `meta/qmd/**` remain blocked by existing meta guardrail;
9. no recall function is imported or changed.

- [ ] **Step 2: Run scheduler tests and verify failure**

Run:

```bash
pnpm exec vitest run test/indexing.test.ts test/indexing-fail-closed.test.ts test/background-tools.test.ts test/guardrails.test.ts --reporter=verbose
```

Expected: QMD scheduling assertions fail.

- [ ] **Step 3: Chain model-free indexing after metadata**

In the existing `scheduleReindex` drain loop:

```ts
const projection = rebuildMetadataLight(paths);
if (!projection.ok) {
  await invalidateQmdAfterProjectionFailure(paths);
  continue;
}

try {
  await reindexQmdVault(paths, {
    scope: "changed",
    components: ["lexical"],
    force: false,
  });
} catch {
  // Generated search indexing is repairable and must not fail the authoritative write.
}

runtime.ensureConfig(root);
const embedder = resolveEmbedder(runtime.config);
if (embedder) await reindexEmbeddings(paths, embedder);
```

`invalidateQmdAfterProjectionFailure` backfills/validates `vault_id`, removes only unsafe entries, and runs a staging lexical update only when removals occurred. It must never add/update valid mirror pages after a projection failure.

Keep the existing dirty flag set until metadata, QMD, and legacy embedding work all finish so writes during any awaited stage trigger the trailing pass.

- [ ] **Step 4: Update explicit metadata rebuild and MCP writers**

Inside `wiki_rebuild_meta`'s existing background work, after `result.ok`, await changed lexical QMD indexing. Return metadata success plus structured QMD warning if indexing fails; the projection remains successful.

After successful `rebuildMetadata` in MCP authoritative write operations, enqueue changed lexical QMD indexing through the same per-vault in-process queue and catch errors. Do not await model work and do not return an authoritative write as failed because generated QMD state failed. Add a test-only `awaitQmdIndexQueue(paths.root)` export so MCP parity tests can drain queued work deterministically.

- [ ] **Step 5: Wire startup recovery**

In Pi `session_start`, after writable-vault validation, launch one background recovery task labeled `qmd-recovery:<root>`. Recovery is generated-state repair and must not block existing heuristic recall.

In MCP `main`, connect the transport first so clients are never blocked by recovery, then run `recoverQmdIndex(getPaths())` as a fire-and-forget task whenever a configured vault exists. Log all outcomes to stderr. A busy/live lock logs one warning and MCP continues with current state untouched; malformed recovery state stays visible through `wiki_status` and `wiki_lint` instead of stalling startup.

Every explicit `reindexQmdVault` also calls recovery first, so repair remains correct when startup hooks were skipped in direct-library tests.

- [ ] **Step 6: Run lifecycle tests**

Run:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/indexing.test.ts test/indexing-fail-closed.test.ts test/background-tools.test.ts test/guardrails.test.ts test/mcp-parity.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

Expected: successful projections schedule lexical indexing; malformed pages can only remove old QMD candidates; existing recall tests remain untouched.

- [ ] **Step 7: Commit**

```bash
git add extensions/llm-wiki/lib/indexing.ts extensions/llm-wiki/lib/tools.ts extensions/llm-wiki/index.ts mcp/operations.ts mcp/index.ts test/indexing.test.ts test/indexing-fail-closed.test.ts test/background-tools.test.ts test/guardrails.test.ts test/mcp-parity.test.ts
git commit -m "feat: maintain QMD indexes after metadata rebuilds"
```

---

### Task 7: Status and Lint Diagnostics

**Files:**
- Modify: `extensions/llm-wiki/lib/wiki-service.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `mcp/operations.ts`
- Modify: `test/mcp-parity.test.ts`
- Modify: `test/lint-okf.test.ts`
- Modify: `test/background-tools.test.ts`

- [ ] **Step 1: Write failing status and lint tests**

Extend shared status expectations:

```ts
expect(status.qmd).toMatchObject({
  state: "ready",
  totalDocuments: 2,
  canonicalDocuments: 1,
  evidenceDocuments: 1,
  needsEmbedding: 2,
  hasVectorIndex: false,
  qmdVersion: "2.5.3",
});
```

Test `missing`, `stale` manifest hash, embedding-model mismatch, valid interrupted swap, malformed state, and recorded last error.

Lint must print one finding for stale/error/recovering QMD state, include stable code, and recommend the exact repair command:

```text
wiki_reindex(scope="changed", components=["lexical"], vault="active")
```

Missing QMD state is informational before first indexing, not a blocking lint failure. A stale vector-only state recommends components `vectors`.

MCP status must equal shared `getWikiStatus`, including QMD object and diagnostics.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec vitest run test/lint-okf.test.ts test/background-tools.test.ts test/mcp-parity.test.ts --reporter=verbose
```

Expected: missing `qmd` status and lint findings.

- [ ] **Step 3: Extend shared status**

Make `getWikiStatus` asynchronous and add:

```ts
export interface WikiStatusSnapshot {
  knowledgeFormat: KnowledgeFormat;
  totalPages: number;
  byType: Record<string, number>;
  blockingDiagnostics: KnowledgeDiagnostic[];
  lastUpdated: string;
  qmd: QmdGeneratedStatus;
}
```

Await `readQmdIndexStatus(paths)` once. Update Pi, MCP, and tests to await `getWikiStatus`. Keep registry counts and knowledge-format behavior unchanged.

Pi status text adds:

```text
QMD index: ready|missing|stale|recovering|error
QMD documents: <total> (<canonical> canonical, <evidence> evidence)
QMD embeddings pending: <count>
QMD package: 2.5.3
```

Tool `details.qmd` is the complete shared status object.

- [ ] **Step 4: Extend lint without mutating QMD**

Make `runWikiLint` async and append findings derived from `readQmdIndexStatus`. Lint may inspect state but must not recover, reindex, remove files, or download models. Keep existing `auto_fix` behavior limited to its current page/metadata fixes.

Map states to diagnostics:

- `stale` → `qmd_index_stale` warning and component-specific repair command;
- `recovering` → `qmd_swap_interrupted` warning and restart/reindex guidance;
- `error` → `qmd_index_error` warning with stored safe message;
- `missing` → no failure, one informational status line.

Do not include absolute source paths or model-cache paths in chat text. Structured local details may retain generated artifact paths.

- [ ] **Step 5: Run status/lint tests**

Run:

```bash
pnpm exec vitest run test/lint-okf.test.ts test/background-tools.test.ts test/mcp-parity.test.ts test/qmd-indexing.test.ts --reporter=verbose
pnpm typecheck
pnpm lint
```

Expected: Pi and MCP status objects match; lint is read-only for QMD.

- [ ] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/wiki-service.ts extensions/llm-wiki/lib/tools.ts mcp/operations.ts test/mcp-parity.test.ts test/lint-okf.test.ts test/background-tools.test.ts
git commit -m "feat: report QMD index health"
```

---

### Task 8: Operator Documentation and Final Phase Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`
- Modify: `docs/commands.md`
- Modify: `skills/llm-wiki/SKILL.md`
- Modify: `test/package-structure.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

Add package-structure checks for:

```ts
for (const path of ["README.md", "docs/api.md", "docs/architecture.md", "docs/commands.md"]) {
  const content = readFile(join(rootDir, path));
  expect(content, path).toContain("wiki_reindex");
  expect(content, path).toContain("meta/qmd");
}
expect(readFile(join(rootDir, "docs/api.md"))).toContain('components: ["lexical", "vectors"]');
expect(readFile(join(rootDir, "docs/architecture.md"))).toContain("generated and rebuildable");
```

- [ ] **Step 2: Run documentation test and verify failure**

Run:

```bash
pnpm exec vitest run test/package-structure.test.ts --reporter=verbose
```

Expected: missing Phase 2 documentation.

- [ ] **Step 3: Document ownership and operational semantics**

Document these facts consistently:

- `.llm-wiki/wiki/**` remains authoritative and user editable;
- `.llm-wiki/meta/qmd/**` is extension-owned, generated, local, and rebuildable;
- QMD never scans authoritative Markdown directly;
- `manifest.json` maps validated mirrors back to `(vault_id, page_id)`;
- canonical and evidence collections never overlap;
- ordinary write-triggered updates are lexical and model-free;
- vector selection may trigger approximately 2 GB of first-use downloads;
- cancellation and failures retain the last usable current store;
- stale/error/recovering status is repaired with `wiki_reindex`;
- full-vault backups include generated searchable text, while OKF-only exports do not;
- users must not edit, copy partially, or restore individual SQLite/WAL/SHM files inside current; restore the whole generated directory or rebuild;
- active recall remains the old heuristic until Phase 3.

Add the complete tool signature to `docs/api.md`:

```text
wiki_reindex(
  scope: "changed" | "all" = "changed",
  components: ("lexical" | "vectors")[] = ["lexical", "vectors"],
  force: boolean = false,
  vault: "active" | "personal" | "project" | "all" = "active"
)
```

Explain that `vectors` first refreshes documents, lexical-only never loads models, `force` applies only to selected components, and `all` vault scope reports each vault independently.

Add `wiki_reindex` to Pi and MCP tool tables. Do not claim QMD powers recall yet.

- [ ] **Step 4: Run all model-free verification**

Run exactly:

```bash
QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-mirror.test.ts test/qmd-contract.test.ts test/qmd-indexing.test.ts test/qmd-indexing-recovery.test.ts test/qmd-reindex-tool.test.ts --reporter=verbose
pnpm test
pnpm typecheck
pnpm lint
pnpm build:mcp
pnpm benchmark:retrieval
```

Expected:

- all tests pass;
- QMD model smoke remains skipped;
- retrieval baseline metrics remain identical to Phase 1 because active recall is unchanged;
- MCP package exposes seven tools;
- `git diff --check` passes.

- [ ] **Step 5: Run optional cached model smoke**

Only when pinned models are already cached or the operator explicitly accepts the download:

```bash
QMD_MODEL_SMOKE=1 QMD_FORCE_CPU=1 pnpm exec vitest run test/qmd-contract.test.ts test/qmd-indexing.test.ts --reporter=verbose
```

Expected: embedding succeeds, vector status becomes fresh, and no reranking/query behavior is wired into recall.

- [ ] **Step 6: Verify phase scope mechanically**

Run:

```bash
git diff main...HEAD -- extensions/llm-wiki/lib/recall.ts extensions/llm-wiki/lib/inject.ts

git grep -n "@tobilu/qmd" -- extensions/llm-wiki | grep -v "lib/qmd-store.ts"

git diff --check

git status --short
```

Expected:

- no diff in active recall or injection files;
- no production QMD import outside `qmd-store.ts`;
- no whitespace errors;
- only planned files changed.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/api.md docs/architecture.md docs/commands.md skills/llm-wiki/SKILL.md test/package-structure.test.ts
git commit -m "docs: document validated QMD indexing"
```

- [ ] **Step 8: Inspect final history and diff**

Run:

```bash
git status --short
git log --oneline -8
git diff --stat main...HEAD
git diff --check main...HEAD
```

Expected: clean implementation tree and eight focused Phase 2 commits after the planning commit. Existing recall remains functional and unchanged; QMD indexes are independently buildable, updateable, inspectable, cancellable, and recoverable. Phase 3 may then plan retrieval modes and recall cutover.
