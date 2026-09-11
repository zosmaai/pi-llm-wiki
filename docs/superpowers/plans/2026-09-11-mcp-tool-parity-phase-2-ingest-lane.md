# MCP Tool Parity Phase 2 — wiki_ingest Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `wiki_ingest` to the MCP server with a config-first model lane so Claude Code / Codex users can run capture → ingest → synthesis end-to-end without the pi runtime.

**Architecture:** The MCP server cannot use pi's modelRegistry (pi-only sessions). Phase 2 adds a thin `mcp/model-lane.ts` that builds pi-ai models from wiki settings (`llm-wiki.taskModel` + new explicit `taskModelBaseUrl` / `taskModelApiKey` / `taskModelApiKeyEnv` fields, mirroring the existing `embedding*` pattern) and exposes the `modelRegistry` shim + a `resolveModel` call that reuses `lib/runtime.ts`'s `Runtime.resolveModel()` UNCHANGED. `mcp/operations.ts` gains `ingestOperation()` that ports the pi tool's packet-selection logic verbatim and loops the batch through the existing `runIngestSynthesis` (ingest-worker.ts) synchronously — no `runtime.launchTask`/UI lane, so MCP returns the per-source report directly. When no model/API key resolves, the operation returns the same "extracted content — synthesize yourself" block the pi tool shows for `background:false`, preserving the graceful degradation.

**Tech Stack:** TypeScript/ESM, `@earendil-works/pi-ai` 0.85.1, `zod/v4`, vitest, biome.

**Roadmap:** Multi-phase host expansion.
- **Phase 1 (DONE — commits in this branch/PR):** 7 model-free tools + Claude Code plugin + Codex/harness docs.
- **Phase 2 (this plan):** `wiki_ingest` over MCP via a config-first model lane.
- **Phase 3 (future):** post-commit embeddings lane + SessionStart ambient notices + npm release packaging.

**Phase:** Phase 2: Config-first ingest lane over MCP

**Branch note:** Execute on the SAME branch (`feat/mcp-tool-parity`) that carries phase 1 — this PR (#246) is intentionally not merged until phases 1+2 are both green and fully tested. `git branch --show-current` must print `feat/mcp-tool-parity`; if it doesn't, `git switch feat/mcp-tool-parity`.

**Review round 1 (fresh-context reviewer, incorporated below):** the pi-ai provider-lane contracts were verified against the installed package and are baked into Tasks 2/5; the second hard-coded tool list in `test/mcp-package.test.ts` is now covered in Task 4; the Task 5 fixtures were corrected to the repo's real settings path (`.pi/settings.json`) and real provider contracts. The pi-ai contract facts are also captured in the wiki observation `obs-2026-09-11-pi-ai-0-85-1-provider-lane-contracts-for-mcp-ports`.

---

## Verification-friendly contract summary (read before Task 2 / Task 5)

Verified against the INSTALLED pi-ai (0.85.1) — these are ground truth, not guesses:

1. **Provider construction** (canonical pattern, `pi-ai/dist/providers/openai.js`):
   ```ts
   import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
   // or for /v1/chat/completions-style servers:
   import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
   import { envApiKeyAuth } from "@earendil-works/pi-ai";  // root export, verified
   import { createProvider } from "@earendil-works/pi-ai";
   createProvider({
     id: "devserver",
     name: "Task model",
     baseUrl: "...",                                   // e.g. http://devserver:8001/v1
     auth: { apiKey: envApiKeyAuth("Task model API key", ["TASK_MODEL_API_KEY"]) },
     models: [{ id: "model-id", provider: "devserver", api: "openai-completions" }],
     api: openAICompletionsApi(),                       // lazyApi builder (deep import OK)
   });
   ```
2. **`lazyApi` takes a LOADER FUNCTION**, not an options object: `lazyApi(() => import("./openai-completions.js"))` (see `dist/api/openai-completions.lazy.js`).
3. **Auth must NEST under `auth`**: `applyAuth` reads `resolution.auth.apiKey` / `resolution.auth.baseUrl`. A flat `{ apiKey, baseUrl }` (or `{ api: {...} }` containing auth) crashes at runtime and is NOT caught by typecheck.
4. **`envApiKeyAuth(name, envNames?)`** is a root export; `fauxProvider(options)` is a root export, takes `{ provider, models, api }` (no `model` key) and returns a handle — you must `store.setProvider(faux.provider)`, and `faux.provider` is the provider object.
5. **Streaming** goes through `Runtime.resolveModel`'s `getRegisteredProviderConfig?(provider)` channel (runtime.ts:66-68):
   ```ts
   getRegisteredProviderConfig?(provider: string):
     { api?: string; streamSimple?: unknown } | undefined;
   ```
   `resolveModel` only wires `streamFn` when `registered?.streamSimple && registered.api === (model as { api?: string }).api` (runtime.ts:174-178). So the lane model must carry `api: "openai-completions"` (a builtin id — `dist/compat.js:109-111` lists `anthropic-messages`, `openai-completions`, `openai-responses`) and the shim must return `{ api: "openai-completions", streamSimple }` for that provider.
6. **pi-ai `exports` map** permits the deep imports `@earendil-works/pi-ai/api/*` (package.json).
7. `Runtime` (runtime.ts:79) has a public mutable `config: TaskConfig` field and `async resolveModel(ctx, override?): Promise<ResolveResult>`; `ResolveResult` = `{ ok: true; apiKey; headers?; streamFn?; env? } | { ok: false; reason }`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `extensions/llm-wiki/lib/task-config.ts` | **Modify** | Add `taskModelBaseUrl` / `taskModelApiKey` / `taskModelApiKeyEnv` to `TaskConfig`, parse in `readNamespacedConfig`, register in `ALL_SETTING_KEYS`. Used ONLY by the non-pi lane; pi keeps its registry path. |
| `mcp/model-lane.ts` | **Create** | Config-first pi-ai provider builder + `modelRegistry` shim (`find` / `getApiKeyAndHeaders` / `getRegisteredProviderConfig`) + `resolveLaneModel(config, providerFactory?, override?)` that delegates to `Runtime.resolveModel` with a shim ctx. `providerFactory` param for test injection. |
| `mcp/operations.ts` | **Modify** | Add `ingestOperation(paths, input)` — port of the pi tool's packet selection + synchronous synthesis loop. Add `readdirSync`/`readFileSync` to the `node:fs` import. |
| `mcp/index.ts` | **Modify** | Register `wiki_ingest` (zod schema; no `background` param — runs synchronously). |
| `test/mcp-ingest-lane.test.ts` | **Create** | Lane unit tests (faux provider) + ingestion behavior tests (no sources / already ingested / commit path). |
| `test/mcp-parity.test.ts` | **Modify** | Append `wiki_ingest` to the 14-tool list (source order, after `wiki_watch`). |
| `test/mcp-package.test.ts` | **Modify** | Append `wiki_ingest` to its hard-coded tool list too (second list, kept in sync with `mcp/index.ts`). |
| `docs/harnesses.md` | **Modify** | Ingest row: now available over MCP; note sync semantics + embedder separation. |
| `docs/superpowers/plans/2026-09-11-mcp-tool-parity-phase-2-ingest-lane.md` | This plan |

Design notes:
- `Runtime.resolveModel` is host-agnostic already (touches only `ctx.model`, `ctx.modelRegistry.*`, `ctx.hasUI/ui`; it never touches the pi session). The lane feeds it a shim ctx with `model: undefined`, `hasUI: false` — resolution failure returns `{ok:false, reason}` which drives the "synthesize yourself" fallback.
- `ingestOperation` never calls `launchEmbedPages` (needs a pi runtime + UI lane). The follow-up embeddings pass is available via the existing `wiki_reindex_embeddings` tool; the divergence is documented.
- The pi ingest tool's per-call `model: 'provider/id'` override parses via `parseModelRef`; the lane honors it through `Runtime.resolveModel`'s override arg.

---

### Task 1: Add the explicit task-model auth fields to `TaskConfig`

**Files:**
- Modify: `extensions/llm-wiki/lib/task-config.ts`

- [x] **Step 1: Extend the interface**

Add after the `embeddingApiKeyEnv` block (interface `TaskConfig`):

```ts
  /**
   * Explicit LLM endpoint for the MCP ingest lane (hosts without pi's model
   * registry). Mirrors the embedding* fields; unused by the pi extension,
   * which resolves the task model through the session registry instead.
   * Prefer taskModelApiKeyEnv to avoid storing secrets in settings files.
   */
  taskModelBaseUrl?: string;
  taskModelApiKey?: string;
  taskModelApiKeyEnv?: string;
```

- [x] **Step 2: Parse the new keys in `readNamespacedConfig`**

Locate the `readNamespacedConfig` block that maps `embeddingApiKey` / `embeddingApiKeyEnv` and add the three mappings right after it (matching the existing style — the `section` is the `llm-wiki` config object already split off by `readNamespacedConfig`):

```ts
    if (typeof section.taskModelBaseUrl === "string") out.taskModelBaseUrl = section.taskModelBaseUrl;
    if (typeof section.taskModelApiKey === "string") out.taskModelApiKey = section.taskModelApiKey;
    if (typeof section.taskModelApiKeyEnv === "string") {
      out.taskModelApiKeyEnv = section.taskModelApiKeyEnv;
    }
```

- [x] **Step 3: Register in `ALL_SETTING_KEYS`**

Add the three keys to the `ALL_SETTING_KEYS` array next to `"embeddingApiKeyEnv"`.

- [x] **Step 4: Verify**

```bash
pnpm exec vitest run test/task-config.test.ts && pnpm typecheck
```

Expected: task-config tests pass and the new keys round-trip (add a two-line test in `test/task-config.test.ts` asserting `loadTaskConfig(root)` returns the three fields when the settings JSON contains them — follow the existing settings-fixture style in that file, which writes `<root>/.omp/settings.json`).

- [x] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/task-config.ts test/task-config.test.ts
git commit -m "feat(config): explicit taskModelBaseUrl/ApiKey/Env for the MCP lane"
```

---

### Task 2: Create `mcp/model-lane.ts`

**Files:**
- Create: `mcp/model-lane.ts`

- [x] **Step 1: Confirm the contract facts (2 min — facts in the contract summary above are pre-verified; confirm against the installed versions):**

```bash
grep -c "export const streamSimple" node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js   # expect 1
grep -n "openAICompletionsApi" node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js   # expect the lazyApi() builder
grep -n "getRegisteredProviderConfig" extensions/llm-wiki/lib/runtime.ts                                 # expect lines 63-68 (+ usage ~174)
```

All three must match the contract summary; the deep imports `@earendil-works/pi-ai/api/openai-completions` and `.lazy` are allowed by pi-ai's `exports` map (verified). If any differs, adapt the code below to the installed shape — the shim contract (`find` / `getApiKeyAndHeaders` / `getRegisteredProviderConfig`) and `Runtime.resolveModel` usage do not change.

- [x] **Step 2: Write `mcp/model-lane.ts`**

```ts
/**
 * Config-first model lane for hosts without pi's model registry (Claude Code,
 * Codex, ...). Builds a pi-ai ModelsStore from llm-wiki settings and exposes
 * the registry shim Runtime.resolveModel expects, so the exact resolution
 * precedence (per-call override -> taskModel -> none) lives in ONE place
 * (lib/runtime.ts) and is shared with the pi extension.
 *
 * The lane reads: taskModel (provider/id), taskModelBaseUrl, taskModelApiKey
 * (or taskModelApiKeyEnv, or the process env of that name). When unset,
 * resolveLaneModel returns ok:false and callers fall back to the
 * "synthesize yourself" path.
 */

import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { streamSimple as openaiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { Runtime, type ResolveResult } from "../extensions/llm-wiki/lib/runtime.js";
import { type ResolveCtx } from "../extensions/llm-wiki/lib/runtime.js";
import { type TaskConfig } from "../extensions/llm-wiki/lib/task-config.js";

// Builtin pi-ai api id for OpenAI-compatible /v1/chat/completions servers
// (dist/compat.js lists: "anthropic-messages" | "openai-completions" | "openai-responses").
const LANE_API = "openai-completions";

/** Builds the provider object store.setProvider() receives. Injectable for tests. */
export type ProviderFactory = (config: TaskConfig) => unknown;

export function defaultProviderFactory(config: TaskConfig): unknown {
  if (!config.taskModel) return undefined;
  return createProvider({
    id: config.taskModel.provider,
    name: `LLM Wiki task model (${config.taskModel.provider}/${config.taskModel.id})`,
    ...(config.taskModelBaseUrl ? { baseUrl: config.taskModelBaseUrl } : {}),
    auth: {
      apiKey: config.taskModelApiKeyEnv
        ? envApiKeyAuth("Task model API key", [config.taskModelApiKeyEnv])
        : {
            name: "taskModelApiKey",
            resolve: async () => ({
              apiKey: config.taskModelApiKey ?? "",
            }),
          },
    },
    models: [
      {
        id: config.taskModel.id,
        provider: config.taskModel.provider,
        api: LANE_API,
      },
    ],
    api: openAICompletionsApi(),
  });
}

/**
 * Build the modelRegistry shim + a standalone Runtime for lane use.
 * `providerFactory` is swappable so tests can inject pi-ai's fauxProvider
 * (`fauxProvider({ provider, models, api }).provider` — the handle itself
 * is NOT setProvider-able).
 */
export function buildLane(
  config: TaskConfig,
  providerFactory: ProviderFactory = defaultProviderFactory,
): { runtime: Runtime; modelRegistry: NonNullable<ResolveCtx["modelRegistry"]> } {
  const store = createModels();
  const provider = providerFactory(config);
  if (provider) store.setProvider(provider);
  const runtime = new Runtime();
  runtime.config = config; // resolveModel reads this.config.taskModel
  const modelRegistry: NonNullable<ResolveCtx["modelRegistry"]> = {
    find: (providerId: string, id: string) => {
      const entry = store.getProvider(providerId);
      if (!entry) return undefined;
      try {
        const found = entry.getModels().find((m) => m.id === id);
        // A store-provider model has no `api` id; without it the runtime's
        // streamFn wiring (registered.api === model.api) never fires.
        return found ? { ...found, api: LANE_API } : undefined;
      } catch {
        return undefined;
      }
    },
    getRegisteredProviderConfig: (providerId: string) => {
      const entry = store.getProvider(providerId);
      if (!entry) return undefined;
      return { api: LANE_API, streamSimple: openaiStreamSimple };
    },
    getApiKeyAndHeaders: async (model: unknown) => {
      const m = model as { provider?: string; id?: string } | undefined;
      const key =
        config.taskModelApiKey ??
        (config.taskModelApiKeyEnv ? process.env[config.taskModelApiKeyEnv] ?? "" : "");
      return {
        ok: typeof key === "string" && key.length > 0,
        ...(key.length > 0 ? { apiKey: key } : {}),
        ...(config.taskModelBaseUrl ? { baseUrl: config.taskModelBaseUrl } : {}),
      };
    },
  };
  return { runtime, modelRegistry };
}

/** Resolve the lane model, delegating precedence to Runtime.resolveModel. */
export async function resolveLaneModel(
  config: TaskConfig,
  providerFactory: ProviderFactory = defaultProviderFactory,
  override?: { provider: string; id: string },
): Promise<ResolveResult> {
  const { runtime, modelRegistry } = buildLane(config, providerFactory);
  return runtime.resolveModel(
    { model: undefined, modelRegistry, hasUI: false } as ResolveCtx,
    override,
  );
}
```

Executor notes:
- `envApiKeyAuth(name, envNames)` — second arg is the env var name(s) list; the `name` is human-facing. Config-direct `taskModelApiKey` uses a plain `resolve` fn nested under `auth.apiKey` (contract fact 3).
- For servers exposing OpenAI's `/v1/responses` instead of `/v1/chat/completions`, swap the two deep imports to `openai-responses.lazy` / `openai-responses` and set `LANE_API = "openai-responses"` (documented in the code comment).
- `ResolveCtx` must come from `lib/runtime.ts` (it already types `modelRegistry`); if the exported name differs, use the inline shape `NonNullable<Parameters<Runtime["resolveModel"]>[0]["modelRegistry"]>` as the shim type instead.
- biome `noUnusedImports` is an ERROR in this repo — do not leave unused imports.

- [x] **Step 3: Typecheck the lane module**

```bash
pnpm typecheck
```

Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add mcp/model-lane.ts
git commit -m "feat(mcp): config-first model lane for non-pi hosts"
```

---

### Task 3: Add `ingestOperation` to `mcp/operations.ts`

**Files:**
- Modify: `mcp/operations.ts`

- [x] **Step 1: Extend the `node:fs` imports (add `readdirSync` and `readFileSync`)**

Change the existing `import { existsSync, mkdirSync } from "node:fs";` to:

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
```

(These are the only two symbols missing — biome forbids unused imports, so do not add `statSync`/`writeFileSync`.)

- [x] **Step 2: Add the operation (port of the pi `wiki_ingest` selection + sync loop)**

Append after `observeOperation`, and add these imports to the top of `operations.ts`:

```ts
import { parseModelRef } from "../extensions/llm-wiki/lib/task-config.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import { runIngestSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { resolveLaneModel } from "./model-lane.js";
```

Then the operation:

```ts
/**
 * Shared ingest operation: the exact pi packet-selection rules, run
 * synchronously over the config-first lane. Mirrors pi's background=false
 * "synthesize yourself" fallback when no model/API key resolves.
 */
export async function ingestOperation(
  paths: VaultPaths,
  input: {
    source_id?: string;
    batch_size?: number;
    model?: string;
  },
): Promise<{ report: string; isError?: boolean }> {
  if (!existsSync(paths.rawSources)) {
    return {
      report: "No raw/sources/ directory. Capture sources first with wiki_capture_source.",
      isError: true,
    };
  }

  const packets = readdirSync(paths.rawSources)
    .filter((d) => d.startsWith("SRC-"))
    .sort();
  const registry = readJson<{ pages: Record<string, unknown> }>(
    join(paths.meta, "registry.json"),
    { pages: {} },
  );
  const ingested = new Set<string>();
  for (const [id, entry] of Object.entries(registry.pages)) {
    if (entry.type === "source" && (entry as Record<string, unknown>).status !== "skeleton") {
      const base = id.split("/").pop();
      if (base) ingested.add(base);
    }
  }

  let toProcess = packets.filter((p) => !ingested.has(p));
  if (input.source_id) {
    if (!toProcess.includes(input.source_id) && !packets.includes(input.source_id)) {
      return {
        report: `Source ${input.source_id} not found or already ingested.`,
        isError: true,
      };
    }
    toProcess = [input.source_id];
  }

  const batch = toProcess.slice(0, Math.min(input.batch_size ?? 3, 5));
  if (batch.length === 0) {
    return { report: "✅ All sources ingested. Use wiki_capture_source to add new ones." };
  }

  const config = loadTaskConfig(paths.root);
  const override = input.model ? parseModelRef(input.model) : undefined;
  const res = await resolveLaneModel(config, undefined, override);
  if (!res.ok) {
    // Mirror pi's background=false output: hand the extracted content to the
    // calling agent so it can synthesize without a background model.
    const sources = batch.map((id) => {
      const manifest = readJson<Record<string, unknown>>(
        join(paths.rawSources, id, "manifest.json"),
        {},
      );
      const extractedPath = join(paths.rawSources, id, "extracted.md");
      return {
        id,
        title: (manifest.title as string) ?? id,
        extractedChars: existsSync(extractedPath)
          ? readFileSync(extractedPath, "utf-8").length
          : 0,
      };
    });
    return {
      report: [
        `⚠️ No background LLM available (${res.reason}) — synthesize these sources yourself:`,
        "",
        ...sources.map((s) => `- **${s.id}**: ${s.title} (${s.extractedChars} chars extracted)`),
        "",
        "1. Read each source's extracted.md",
        "2. Update the skeleton source page in wiki/sources/",
        "3. Create/update entity pages in wiki/entities/",
        "4. Create/update concept pages in wiki/concepts/",
        "5. Add [[wikilinks]] cross-references",
        "6. Flag contradictions",
        "",
        "The extension will auto-update metadata when you are done.",
      ].join("\n"),
    };
  }

  const summaries: string[] = [];
  for (const id of batch) {
    const extractedPath = join(paths.rawSources, id, "extracted.md");
    const manifestPath = join(paths.rawSources, id, "manifest.json");
    const extracted = existsSync(extractedPath) ? readFileSync(extractedPath, "utf-8") : "";
    const manifest: Record<string, unknown> = readJson(manifestPath, {});
    const committed = await runIngestSynthesis({
      model: res.model as Parameters<typeof runIngestSynthesis>[0]["model"],
      apiKey: res.apiKey,
      headers: res.headers,
      streamFn: res.streamFn as Parameters<typeof runIngestSynthesis>[0]["streamFn"],
      env: res.env,
      paths,
      sourceId: id,
      manifest,
      extracted,
      synthesisLanguage: config.synthesisLanguage,
      wikilinkValidation: config.wikilinkValidation,
    });
    const wl = committed?.wikilinkDiagnostics?.length ?? 0;
    const wlNote = wl > 0 ? `, ${wl} wikilink issue${wl === 1 ? "" : "s"}` : "";
    summaries.push(
      committed
        ? `**${id}**: ingested → ${committed.entitiesCreated.length} entit${committed.entitiesCreated.length === 1 ? "y" : "ies"} created, ${committed.entitiesLinked.length} linked, ${committed.conceptsCreated.length} concept${committed.conceptsCreated.length === 1 ? "" : "s"} created, ${committed.conceptsLinked.length} linked${wlNote}`
        : `**${id}**: model produced no synthesis`,
    );
  }
  return {
    report: `${summaries.join("\n")}\n\nBatch: ${batch.length} source${batch.length === 1 ? "" : "s"} (${toProcess.length} pending, ${toProcess.length - batch.length} remaining).`,
  };
}
```

Executor notes:
- Verify `readJson`'s signature/generics in `operations.ts` (it already exists there — used by `observeOperation` etc.) and match its call style; the generic in `readJson<...>` may be positional-only — adapt if typecheck complains.
- `CommitResult` field names (`entitiesCreated`, `entitiesLinked`, `conceptsCreated`, `conceptsLinked`, `wikilinkDiagnostics`) are verified against the pi tool body in `extensions/llm-wiki/lib/tools.ts` — keep them in sync if any diverge.
- `res.env` / `res.headers` are already `Record<string, string>`-compatible from `ResolveResult`; pass them straight through.
- The stitching check in `tools.ts` first verifies `existsSync(paths.rawSources)`; keep that guard (it is what the first test asserts).

- [x] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add mcp/operations.ts
git commit -m "feat(mcp): wiki_ingest operation with sync lane + self-synthesize fallback"
```

---

### Task 4: Register `wiki_ingest` in `mcp/index.ts`

**Files:**
- Modify: `mcp/index.ts`

- [x] **Step 1: Import the operation**

Add `ingestOperation,` to the `./operations.js` import list.

- [x] **Step 2: Register the tool after `wiki_watch` (append at the very end of the tool sections, before `// ─── Main ───`)**

```ts
// ---- wiki_ingest ----

server.registerTool(
  "wiki_ingest",
  {
    description:
      "Process uningested source packets (captured with wiki_capture_source) by running " +
      "the synthesis sub-agent over the configured llm-wiki task model, then committing " +
      "pages. Runs synchronously over this server's model lane (llm-wiki.taskModel + " +
      "taskModelApiKey/taskModelBaseUrl). When no model is available, returns the " +
      "extracted content and instructions so the calling agent can synthesize itself.",
    inputSchema: z.object({
      source_id: z.string().optional().describe("Specific source ID to ingest"),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(3)
        .describe("Max sources to process (1-5)"),
      model: z.string().optional().describe("Per-call model override as 'provider/id'"),
    }),
  },
  async ({ source_id, batch_size, model }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = await ingestOperation(paths, {
      source_id,
      batch_size,
      model,
    });
    return {
      content: [{ type: "text" as const, text: result.report }],
      ...(result.isError ? { isError: true as const } : {}),
    };
  },
);
```

- [x] **Step 3: Update BOTH parity tool lists (15 tools, source order)**

There are two hard-coded 14-tool lists that must stay in sync with `mcp/index.ts` registration order:

1. `test/mcp-parity.test.ts` — append `"wiki_ingest"` as the LAST element (registered after `wiki_watch`):

```ts
      "wiki_reindex_embeddings",
      "wiki_watch",
      "wiki_ingest",
    ]);
```

2. `test/mcp-package.test.ts` — find its tool list (the second hard-coded list discovered in phase 1) and append `"wiki_ingest"` in the same relative position (after `"wiki_watch"`).

- [x] **Step 4: Run the MCP tests**

```bash
pnpm exec vitest run test/mcp-parity.test.ts test/mcp-package.test.ts
```

Expected: all pass (both count assertions now see 15 tools).

- [x] **Step 5: Commit**

```bash
git add mcp/index.ts test/mcp-parity.test.ts test/mcp-package.test.ts
git commit -m "feat(mcp): expose wiki_ingest over MCP (15 tools)"
```

---

### Task 5: Lane + ingest tests

**Files:**
- Create: `test/mcp-ingest-lane.test.ts`

- [x] **Step 1: Write the test file**

Settings in this repo are read from `<root>/.pi/settings.json` (`.omp` on omp hosts) by `loadTaskConfig` — do NOT write `.llm-wiki/config.json` (that is the vault config, not the settings file). The `fauxProvider` contract: root export, takes `{ provider, models, api }` (no `model` key), and returns a handle whose `.provider` member is setProvider-able.

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import { resolveLaneModel } from "../mcp/model-lane.js";
import { ingestOperation } from "../mcp/operations.js";

const FAUX_PROVIDER = "faux";
const FAUX_MODEL = "faux-test";

/** pi-ai's test-double provider handle; the factory must return `.provider`. */
function fauxFactory(): unknown {
  return fauxProvider({
    provider: FAUX_PROVIDER,
    models: [{ id: FAUX_MODEL, provider: FAUX_PROVIDER }],
  }).provider;
}

let root: string;
beforeEach(() => {
  root = join(
    import.meta.dirname,
    "..",
    "tmp",
    `mcp-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({
      "llm-wiki": {
        mode: "personal",
        taskModel: { provider: FAUX_PROVIDER, id: FAUX_MODEL },
        taskModelApiKey: "test-key",
        taskModelBaseUrl: "http://localhost",
      },
    }),
  );
  ensureVaultStructure(getVaultPaths(root));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

it("resolveLaneModel resolves a model from the config-first lane (faux provider)", async () => {
  const res = await resolveLaneModel(loadTaskConfig(root), fauxFactory);
  expect(res.ok).toBe(true);
});

it("resolveLaneModel degrades gracefully when no model is configured", async () => {
  const cfg = loadTaskConfig(root);
  const bare = { ...cfg, taskModel: undefined };
  const res = await resolveLaneModel(bare, fauxFactory);
  expect(res.ok).toBe(false);
});

it("ingestOperation reports when the vault has no raw packets at all", async () => {
  const paths = getVaultPaths(root);
  rmSync(paths.rawSources, { recursive: true, force: true });
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBe(true);
  expect(res.report).toContain("No raw/sources/ directory");
});

it("ingestOperation reports when every source is already ingested", async () => {
  const paths = getVaultPaths(root);
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBeUndefined();
  expect(res.report).toContain("All sources ingested");
});

it("ingestOperation falls back to self-synthesize instructions when the lane has no model", async () => {
  // Rewrite settings WITHOUT taskModel so the lane degrades.
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ "llm-wiki": { mode: "personal" } }),
  );
  const paths = getVaultPaths(root);
  mkdirSync(join(paths.rawSources, "SRC-2026-09-11-001"), { recursive: true });
  writeFileSync(
    join(paths.rawSources, "SRC-2026-09-11-001", "extracted.md"),
    "hello world",
  );
  writeFileSync(
    join(paths.rawSources, "SRC-2026-09-11-001", "manifest.json"),
    JSON.stringify({
      kind: "text",
      title: "Lane Test",
      captured_at: "2026-09-11T00:00:00Z",
    }),
  );
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBeUndefined();
  expect(res.report).toContain("synthesize these sources yourself");
  expect(res.report).toContain("SRC-2026-09-11-001");
});
```

Executor notes:
- `ensureVaultStructure(getVaultPaths(root))` DOES create `.llm-wiki/raw/sources` — that is why the "already ingested"-vs-"no packets" assertions are split: delete the dir to test the missing-raw error.
- If `fauxProvider`'s `.provider` shape differs on the installed version (e.g. `faux.provider` is async-refreshed), adapt `fauxFactory` — the failing test reveals the real contract. `store.setProvider(provider)` must accept whatever you return.
- `ingestOperation` returning `{ report }` without `isError` — assert with `res.isError` being undefined, matching the operation's return type.

- [x] **Step 2: Run the new tests**

```bash
pnpm exec vitest run test/mcp-ingest-lane.test.ts
```

Expected: all pass.

- [x] **Step 3: Commit**

```bash
git add test/mcp-ingest-lane.test.ts
git commit -m "test(mcp): ingest lane — faux-provider resolution + self-synthesize fallback"
```

---

### Task 6: Docs + full verification + live MCP smoke

**Files:**
- Modify: `docs/harnesses.md`, `README.md` (ingest row), then the full gate.

- [x] **Step 1: Update `docs/harnesses.md`**

In the matrix, the Codex/Cursor/etc. "Limits" cells currently say "background ingest ... not available (Phase 2)". Replace with: "`wiki_ingest` runs synchronously over the configured `llm-wiki.taskModel*` settings; no background reporting". In the Architecture section, add:

```markdown
### Model lane (wiki_ingest)

Non-pi hosts have no pi model registry. The MCP server reads
`llm-wiki.taskModel` plus the optional `taskModelBaseUrl` / `taskModelApiKey`
/ `taskModelApiKeyEnv` settings (same shape as the embedding\* fields) and
resolves a model through the SAME precedence as pi
(`lib/runtime.ts::resolveModel`): per-call override → taskModel → none. When
nothing resolves, `wiki_ingest` returns the extracted content so the calling
agent can synthesize the pages itself.
```

- [x] **Step 2: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected:
- typecheck: PASS.
- lint: only the pre-existing `useOptionalChain` warning remains (verify no new warnings in `mcp/model-lane.ts` / operations / tests).
- test: all files pass (894 baseline + new lane tests; both 15-tool count tests green).

- [x] **Step 3: Rebuild + live MCP smoke**

```bash
pnpm build:mcp
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | timeout 10 node dist/mcp/index.js
```

Expected: the server starts and the tool list includes `wiki_ingest` (alongside the other 14). Note: the initialize handshake must precede tools/list in real MCP; a bare tools/list pipe may elicit a server-init error — in that case use the initialize→tools/list sequence from Task 5 of the phase-1 plan and grep for `"name":"wiki_ingest"`.

**Live end-to-end (manual, network needed — omarchy has the devserver task model configured for this wiki):**

```bash
WIKI_ROOT=/tmp/mcp-e2e node dist/mcp/index.js   # in one shell
# in another, send: initialize -> tools/call wiki_bootstrap -> wiki_capture_source(text="Sample source about MCP")
# -> wiki_ingest (batch_size 1) -> wiki_recall(query="MCP")
```

Expected: capture creates `SRC-*`, `wiki_ingest` returns per-source ingest summaries (or the self-synthesize fallback if no `taskModel*` key is configured for `/tmp/mcp-e2e`). Record the observed output in the PR body.

- [x] **Step 4: Commit any doc changes**

```bash
git add docs/harnesses.md README.md
git commit -m "docs: ingest lane + MCP sync semantics in harness matrix"
```

- [x] **Step 5: Push the branch + report**

```bash
git push arjun-zosma HEAD:feat/mcp-tool-parity
git log --oneline origin/main..HEAD
```

Expected: phase-1 (8 commits) + phase-2 commits on one branch; PR #246 now carries both phases. Then run the FULL verification one last time (`pnpm test` tail line) and report per-task results with commit hashes.

---

## Self-review notes

- **Vendor-API risk:** the only external contract (pi-ai provider construction, auth nesting, lazyApi loader form, streaming channel) is now PRE-VERIFIED and hard-coded into Task 2 + the contract summary; Task 2 Step 1 is a 2-minute confirm with concrete greps. No placeholder recon remains.
- **Type consistency:** `resolveLaneModel(config, providerFactory?, override?)`, `buildLane(config, providerFactory?)`, `ingestOperation(paths, input)` used identically across Tasks 2-5; BOTH hard-coded 15-tool lists match the actual registration order (ingest appended after watch).
- **Phase boundary health:** the branch remains green at every task's end; pi behavior is untouched (TaskConfig fields are additive and unused by the pi extension); ingest over MCP is strictly additive. Post-commit embedding launch and background reporting are documented as remaining pi-only (Phase 3).
- **Known divergences, documented:** sync vs background reports; no automatic embedding pass after MCP ingest (call `wiki_reindex_embeddings`); `background` param intentionally absent.
- **Review provenance:** this is the review-round-1-revised plan. Round 1 (fresh-context reviewer) found three Important issues — ineffective pi-ai recon (fixed: verified contracts inlined), missing `mcp-package.test.ts` second tool list (fixed: Task 4 Step 3), and two broken Task 5 tests (fixed: `.pi/settings.json` fixture + split assertions + faux `.provider` unwrap).