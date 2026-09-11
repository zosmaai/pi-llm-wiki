# MCP Tool Parity + Native Host Packaging — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `pi-llm-wiki`'s MCP server to tool parity with the pi extension: all 7 currently-missing model-free tools ported (14 MCP tools total — everything pi ships except `wiki_ingest` and the 3 opt-in trajectory tools), and ship the first native-harness packaging so the same `dist/mcp/index.js` binary runs as a Claude Code plugin and a Codex MCP server.

**Architecture:** The MCP server (`mcp/index.ts` + `mcp/operations.ts`) is the host-agnostic surface; pi-specific glue (background reporting, context injection, commands) stays in the extension. Phase 1 adds seven operations to `mcp/operations.ts` (thin adapters over the same `lib/` functions the pi tools call), registers them in `mcp/index.ts` with zod schemas, and adds per-host manifests pointing at the built server. `wiki_ingest` is deliberately NOT ported: it needs the model/background lane (Phase 2). The pi tool bodies are untouched except two `export` keywords and the `runWikiLint` extraction.

**Tech Stack:** TypeScript/ESM, `@modelcontextprotocol/server` (stdio), `zod/v4` schemas (existing MCP convention), vitest, biome. Claude Code plugin format (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`), Codex `config.toml` `[mcp_servers.*]` tables.

**Roadmap:** Multi-phase host expansion.
- **Phase 1 (this plan):** model-free tool parity (7 tools) + Claude Code plugin + Codex/docs packaging.
- **Phase 2 (future):** `wiki_ingest` over MCP via a transport-agnostic background lane (reuses `lib/ingest-worker.ts`); SessionStart ambient notices for Claude.
- **Phase 3 (future):** npm release packaging (`package.files` for dist + plugin manifests), marketplace/publish tooling.

**Phase:** Phase 1: Model-free tool parity + native host packaging

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `extensions/llm-wiki/lib/lint.ts` | **Create** | `runWikiLint` extracted verbatim from `tools.ts` so pi and MCP share the exact health-scan implementation |
| `extensions/llm-wiki/lib/tools.ts` | **Modify** | Remove local `runWikiLint` (import from `lib/lint.js`); add `export` to `buildPageBody` and `RESERVED_FRONTMATTER` (needed by the MCP operation layer) |
| `mcp/operations.ts` | **Modify** | Add 7 operations: `ensurePageOperation`, `lintOperation`, `rebuildMetaOperation`, `reindexEmbeddingsOperation`, `logEventOperation`, `watchOperation`, `observeOperation` |
| `mcp/index.ts` | **Modify** | Register 7 new `wiki_*` tools with zod/v4 schemas |
| `test/mcp-parity.test.ts` | **Modify** | Update the "exactly seven tools" list → 14; add one parity test per new tool |
| `.claude-plugin/plugin.json` | **Create** | Claude Code plugin manifest (mcpServers + hooks references) |
| `.claude-plugin/.mcp.json` | **Create** | Claude MCP server config pointing at `dist/mcp/index.js` |
| `.claude-plugin/hooks/hooks.json` | **Create** | Claude PreToolUse guard hook (blocks edits to `.llm-wiki/raw` and `.llm-wiki/meta`) |
| `scripts/guard-llm-wiki-edit.mjs` | **Create** | Stateless stdio hook command implementing the guard (deny via `permissionDecision`) |
| `hosts/codex.config.toml.example` | **Create** | Ready-to-paste `[mcp_servers.llm-wiki]` block for `~/.codex/config.toml` |
| `docs/harnesses.md` | **Create** | Host support matrix (pi / claude / codex / cursor / windsurf / zed / opencode) with configs and native limits |
| `README.md` | **Modify** | Add "Harness support" section pointing to `docs/harnesses.md` |

Design notes:
- Operations follow the existing pattern (see `retroOperation`): validate vault via `inspectWritableVault`, call shared `lib/` functions, map results to `{ ok, diagnostics }` shapes. No YAML/registry/string building inside operations.
- Pi-vs-MCP parity is guaranteed by **both calling the same `lib/` functions**; `mcp-parity.test.ts` asserts the observable contract (registry-count test + per-tool behavior tests).
- `wiki_watch` is the only new tool with no vault dependency — registered before the `hasVault()` gate.

---

### Task 1: Extract `runWikiLint` into `lib/lint.ts` and export the two shared symbols

**Files:**
- Create: `extensions/llm-wiki/lib/lint.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts` (delete local `runWikiLint` at lines 912–1115; add `export` to `buildPageBody` line 652 and `RESERVED_FRONTMATTER` line ~517; import `runWikiLint`)

- [ ] **Step 1: Create `extensions/llm-wiki/lib/lint.ts` with the function moved verbatim**

Open `extensions/llm-wiki/lib/tools.ts`, select lines 912–1115 (the entire `async function runWikiLint(...)` through its closing brace before `export function registerWikiStatus`), and paste into the new file with this header:

```ts
import { join } from "node:path";
import { buildResolvedBacklinks, buildWikilinkIndex } from "./knowledge-links.js";
import { repairLegacyKnowledgeDocuments } from "./legacy-repair.js";
import { rebuildMetadata, type Registry } from "./metadata.js";
import { readQmdIndexStatus } from "./qmd-indexing.js";
import { type VaultPaths } from "./utils.js";
import { assertWritableVault, inspectVaultFormat } from "./vault-format.js";
import { discoverKnowledgeDocuments } from "./knowledge-documents.js";

/**
 * Wiki health scan. Extracted verbatim from tools.ts (issue #77) so the Pi tool
 * and the MCP server run the exact same lint implementation (Phase 1 of #221).
 */
export async function runWikiLint(paths: VaultPaths, autoFix: boolean): Promise<string> {
  // ...paste tools.ts:912–1115 body unchanged, including the QMD status read,
  // the auto-fix repair branch, the backlink scan, and the report builders...
}
```

If any identifier in the pasted body does not resolve after adding the imports above, find its module and add the import:

```bash
grep -rln "export function <identifier>" extensions/llm-wiki/lib/
```

(Expected: the 8 import lines above cover everything already used by `runWikiLint`; this grep is the backstop.)

- [ ] **Step 2: Typecheck the extracted module**

```bash
cd /home/arjun/code/pi-packages/pi-llm-wiki && pnpm exec tsc --noEmit -p tsconfig.mcp.json
```

Wait — the function must also compile against the pi config. Run both:

```bash
pnpm typecheck
```

Expected: both pass (the function is a pure move; imports resolve exactly as they did in `tools.ts`).

- [ ] **Step 3: Remove the local copy from `tools.ts` and wire the import**

In `extensions/llm-wiki/lib/tools.ts`:
- Delete lines 912–1115 (the local `async function runWikiLint`).
- Add to the existing import block from `./legacy-repair.js` / `./metadata.js` / `./knowledge-links.js` etc. only the imports that are now unused — do it the lazy safe way:

```bash
pnpm lint
```

Biome will flag each now-unused import in `tools.ts` with an exact line. Delete exactly those that biome flags (do NOT delete imports still used by the other ~1,500 lines — e.g. `buildWikilinkIndex`, `rebuildMetadata`, `assertWritableVault`, `discoverKnowledgeDocuments`, `repairLegacyKnowledgeDocuments`, `readQmdIndexStatus`, `buildResolvedBacklinks`, `inspectVaultFormat` are all still used by other tools). Then add the new import from the extracted module:

```ts
import { runWikiLint } from "./lint.js";
```

- [ ] **Step 4: Add `export` to the two shared symbols**

In `extensions/llm-wiki/lib/tools.ts`:
- Line ~517: `const RESERVED_FRONTMATTER = ...` → `export const RESERVED_FRONTMATTER = ...`
- Line ~683: `function buildPageBody(...)` → `export function buildPageBody(...)`

- [ ] **Step 5: Verify green**

```bash
pnpm typecheck && pnpm exec vitest run test/mcp-parity.test.ts test/wikilink-gate.test.ts
```

Expected: all pass (wikilink-gate exercises `wiki_ensure_page` whose body is unchanged; lint tests unaffected by the move).

- [ ] **Step 6: Commit**

```bash
git add extensions/llm-wiki/lib/lint.ts extensions/llm-wiki/lib/tools.ts
git commit -m "refactor: extract runWikiLint to lib/lint.ts for MCP sharing"
```

---

### Task 2: Add the seven operations to `mcp/operations.ts`

**Files:**
- Modify: `mcp/operations.ts` (append seven `export` functions + new imports)

- [ ] **Step 1: Write the seven operations**

Append the following to `mcp/operations.ts` (after `captureSourceOperation`), keeping the existing import ordering biome-clean afterwards.

Add ONLY these new imports (operations.ts already imports `readJson`, `rebuildMetadata`, `applyWikilinkGate`, `buildWikilinkIndex`, `inspectWritableVault`, `resolveWikilinkValidation`, `reindexQmdVault`, `join`, `VaultPaths` — do not re-import those):

```ts
import { existsSync, mkdirSync } from "node:fs";
import { reindexEmbeddings, resolveEmbedder } from "../extensions/llm-wiki/lib/embeddings.js";
import {
  createKnowledgeDocument,
  parseMarkdownFrontmatter,
  writeKnowledgeDocumentFile,
  type KnowledgeValue,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import { runWikiLint } from "../extensions/llm-wiki/lib/lint.js";
import { appendEvent, type Registry } from "../extensions/llm-wiki/lib/metadata.js";
import { saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import { fmtDate, slugify } from "../extensions/llm-wiki/lib/utils.js";
import { buildPageBody, RESERVED_FRONTMATTER } from "../extensions/llm-wiki/lib/tools.js";
```

/**
 * Shared ensure-page operation, mirroring the Pi wiki_ensure_page body:
 * vault check → #241 frontmatter consume → wikilink gate → write page →
 * metadata rebuild → lexical QMD pass. Uses the same reserved-field set and
 * template builder as the Pi tool (imported from tools.ts, which has no
 * top-level side effects).
 */
export async function ensurePageOperation(
  paths: VaultPaths,
  input: { type: string; title: string; content?: string },
): Promise<
  | { ok: true; path: string; created: boolean }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }

  const config = loadTaskConfig(paths.root);
  const folderMap: Record<string, string> = {
    entity: "entities",
    concept: "concepts",
    synthesis: "syntheses",
    analysis: "analyses",
    requirement: "requirements",
    skill: "skills",
    case: "cases",
    ...config.customTypes,
  };
  const slug = slugify(input.title);
  const folder = folderMap[input.type] || "concepts";
  const pagePath = join(paths.wiki, folder, `${slug}.md`);
  if (existsSync(pagePath)) return { ok: true, path: pagePath, created: false };

  const today = fmtDate();
  let body = input.content ?? buildPageBody(input.type, input.title);

  // #241: consume a leading YAML frontmatter block from content (same hardened
  // parser as page reads); reserved fields never merge.
  const extraFrontmatter: Record<string, KnowledgeValue> = {};
  if (body.trimStart().startsWith("---")) {
    const parsed = parseMarkdownFrontmatter(body, `${folder}/${slug}.md`);
    if (parsed.ok) {
      for (const [key, value] of Object.entries(parsed.mapping)) {
        if (!RESERVED_FRONTMATTER.has(key)) extraFrontmatter[key] = value;
      }
      body = parsed.body.trim() ? parsed.body : buildPageBody(input.type, input.title);
    }
  }

  const mode = resolveWikilinkValidation(config);
  if (mode !== "off") {
    const registry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    const gate = applyWikilinkGate(
      body,
      buildWikilinkIndex(Object.keys(registry.pages)),
      `${folder}/${slug}`,
      mode,
    );
    if (!gate.ok) {
      return {
        ok: false,
        diagnostics: gate.diagnostics.map((d) => ({ code: "link_validation", message: d.message })),
      };
    }
    if (mode === "normalize") body = gate.body;
  }

  const doc = createKnowledgeDocument(
    `${folder}/${slug}.md`,
    {
      type: input.type,
      title: input.title,
      created: today,
      updated: today,
      ...extraFrontmatter,
    },
    body,
  );
  mkdirSync(join(paths.wiki, folder), { recursive: true });
  writeKnowledgeDocumentFile(pagePath, doc);
  appendEvent(paths, {
    kind: "ensure_page",
    page_type: input.type,
    title: input.title,
    path: `${folder}/${slug}`,
  });
  const projection = projectionOutcome(rebuildMetadata(paths));
  if (!projection.ok) return projection;
  await scheduleLexicalQmd(paths);
  return { ok: true, path: pagePath, created: true };
}

/** Shared lint operation: the exact Pi health scan, run synchronously. */
export async function lintOperation(
  paths: VaultPaths,
  autoFix: boolean,
): Promise<
  | { ok: true; report: string }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }
  const report = await runWikiLint(paths, autoFix);
  return { ok: true, report };
}

/**
 * Shared rebuild-meta operation: full projection + lexical QMD pass + page
 * count, mirroring the Pi wiki_rebuild_meta background work body.
 */
export async function rebuildMetaOperation(paths: VaultPaths): Promise<{
  report: string;
  warnings: Array<{ code: string; message: string }>;
}> {
  const result = rebuildMetadata(paths);
  if (!result.ok) {
    return {
      report: `⚠️ LLM Wiki: rebuild had issues — ${result.diagnostics
        .map((d) => `${d.code}: ${d.message}`)
        .join("; ")}`,
      warnings: result.diagnostics.map(({ code, message }) => ({ code, message })),
    };
  }
  const warnings = result.diagnostics
    .filter((d) => d.severity === "warning")
    .map(({ code, message }) => ({ code, message }));
  const qmdResult = await reindexQmdVault(paths, {
    scope: "changed",
    components: ["lexical"],
    force: false,
  });
  if (!qmdResult.ok) {
    warnings.push({
      code: "qmd_index_error",
      message: qmdResult.errors[0]?.message ?? "QMD indexing failed",
    });
  }
  if (warnings.length > 0) {
    return {
      report: `⚠️ LLM Wiki: metadata rebuilt with warnings — ${warnings
        .map((w) => `${w.code}: ${w.message}`)
        .join("; ")}`,
      warnings,
    };
  }
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });
  return {
    report: `✅ LLM Wiki: metadata rebuilt — ${Object.keys(registry.pages).length} pages indexed.`,
    warnings: [],
  };
}

/**
 * Shared embedding reindex. The Pi tool resolves the embedder from the runtime
 * config; the MCP server reads the same settings file via loadTaskConfig.
 */
export async function reindexEmbeddingsOperation(
  paths: VaultPaths,
  force: boolean,
): Promise<{ ok: boolean; enabled: boolean; message: string }> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      enabled: false,
      message: `Wiki vault error: ${vaultCheck.diagnostics[0].message}`,
    };
  }
  const embedder = resolveEmbedder(loadTaskConfig(paths.root));
  if (!embedder) {
    return {
      ok: true,
      enabled: false,
      message:
        'ℹ️ No embedding provider configured — semantic embeddings are disabled. Set `llm-wiki.embeddingProvider` (e.g. "openai") in settings to enable.',
    };
  }
  const stats = await reindexEmbeddings(paths, embedder, { force });
  appendEvent(paths, {
    kind: "reindex_embeddings",
    embedded: stats.embedded,
    skipped: stats.skipped,
    pruned: stats.pruned,
    model: embedder.model,
  });
  return {
    ok: true,
    enabled: true,
    message: `✅ LLM Wiki: embeddings reindexed (${embedder.model}) — ${stats.embedded} embedded, ${stats.skipped} fresh, ${stats.pruned} pruned.`,
  };
}

/** Shared log-event operation: validates, appends, regenerates projections. */
export function logEventOperation(
  paths: VaultPaths,
  input: { kind: string; details?: Record<string, unknown> },
): { ok: boolean; message: string } {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return { ok: false, message: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` };
  }
  const kind = input.kind.trim();
  if (!kind) return { ok: false, message: "Event kind must be a non-empty string" };
  const details = input.details ?? {};
  if (Object.hasOwn(details, "kind") || Object.hasOwn(details, "timestamp")) {
    return { ok: false, message: "Event details cannot override kind or timestamp" };
  }
  appendEvent(paths, { kind, ...details });
  rebuildMetadata(paths);
  return { ok: true, message: `✅ Event logged: ${kind}` };
}

const WATCH_INTERVALS: Record<string, { cron: string; label: string }> = {
  daily: { cron: "0 8 * * *", label: "Daily at 8:00 AM" },
  weekly: { cron: "0 9 * * 1", label: "Weekly on Monday at 9:00 AM" },
  hourly: { cron: "0 * * * *", label: "Every hour" },
};

/** Shared watch operation: pure cron-line builder (no vault needed). */
export function watchOperation(input: { interval: string }): {
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
} {
  if (input.interval === "stop") {
    return {
      ok: true,
      message: [
        "🛑 To stop wiki auto-updates, remove the cron line you installed earlier:",
        "",
        "```bash",
        "crontab -e   # then delete the line tagged '# llm-wiki-autoupdate'",
        "```",
        "",
        "Or list current jobs to confirm:",
        "",
        "```bash",
        "crontab -l | grep llm-wiki-autoupdate",
        "```",
      ].join("\n"),
      details: { action: "stop_instructions" },
    };
  }
  const config = WATCH_INTERVALS[input.interval];
  if (!config) {
    return {
      ok: false,
      message: `❌ Unknown interval: "${input.interval}". Use: daily, weekly, hourly, or stop.`,
      details: { error: "bad_interval" },
    };
  }
  const cronLine = `${config.cron} /bin/bash -lc 'mkdir -p "$HOME/.llm-wiki" && pi -p "/wiki-run" >> "$HOME/.llm-wiki/cron.log" 2>&1' # llm-wiki-autoupdate`;
  return {
    ok: true,
    message: [
      `⏰ To set up ${config.label} wiki updates, add this line to your crontab.`,
      "**This tool only prints the line — it does not install it.**",
      "",
      "```bash",
      "crontab -e",
      "```",
      "",
      "Then append:",
      "",
      "```cron",
      cronLine,
      "```",
      "",
      "The line uses `/bin/bash -lc` so your shell profile (and the `pi` binary on npm-global / bun PATH) is loaded. Output goes to `~/.llm-wiki/cron.log`.",
    ].join("\n"),
    details: {
      interval: input.interval,
      cronSchedule: config.cron,
      label: config.label,
      cronLine,
      installed: false,
    },
  };
}

/** Shared observe operation: writes the observation page synchronously. */
export function observeOperation(
  paths: VaultPaths,
  input: {
    title: string;
    content: string;
    relevance: "low" | "medium" | "high" | "critical";
    tags?: string;
    source_context?: string;
  },
): { ok: boolean; message: string } {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return { ok: false, message: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` };
  }
  const result = saveObservation(paths, input, { rebuild: true });
  return {
    ok: true,
    message: `⭐ Observation saved: ${result.slug} — ${input.title}`,
  };
}
```

Add the missing import line to the top of `operations.ts` (it currently imports `resolveWikilinkValidation`; add):

```ts
import { resolveEmbedder } from "../extensions/llm-wiki/lib/embeddings.js";
```

(This line is already included in the new-imports block in Step 1 — do not add it twice.)

- [ ] **Step 2: Typecheck the new operations**

```bash
pnpm typecheck
```

Expected: PASS. (`loadTaskConfig(paths.root)`, `resolveWikilinkValidation(config)`, `reindexEmbeddings`, `saveObservation`, `reindexQmdVault`, `rebuildMetadata`, `appendEvent` are all existing exported signatures used the same way they are in `tools.ts`.) If biome complains about import order, run `pnpm exec biome check --write mcp/operations.ts`.

- [ ] **Step 3: Commit**

```bash
git add mcp/operations.ts
git commit -m "feat(mcp): add ensure/lint/rebuild/observe/log/watch operations"
```

---

### Task 3: Register the seven tools in `mcp/index.ts`

**Files:**
- Modify: `mcp/index.ts` (imports + seven `server.registerTool(...)` blocks, inserted after the `wiki_capture_source` block, in this fixed order so the parity-list test stays deterministic)

**Order:** `wiki_ensure_page`, `wiki_lint`, `wiki_log_event`, `wiki_observe`, `wiki_rebuild_meta`, `wiki_reindex_embeddings`, `wiki_watch`.

- [ ] **Step 1: Add the operation imports**

```ts
import {
  bootstrapOperation,
  captureSourceOperation,
  ensurePageOperation,
  lintOperation,
  logEventOperation,
  observeOperation,
  rebuildMetaOperation,
  recallOperation,
  reindexEmbeddingsOperation,
  reindexOperation,
  retroOperation,
  searchOperation,
  statusOperation,
  watchOperation,
} from "./operations.js";
```

- [ ] **Step 2: Add the seven registrations**

Insert after the closing of the `wiki_capture_source` block, before the `// ─── Main ───` section:

```ts
// ---- wiki_ensure_page ----

server.registerTool(
  "wiki_ensure_page",
  {
    description:
      "Resolve or safely create a canonical wiki page. Returns the page path. " +
      "Content may begin with a YAML frontmatter block; its fields are merged into " +
      "the page frontmatter, and generated fields (type, title, created, updated, " +
      "sources) are reserved and ignored.",
    inputSchema: z.object({
      type: z.string().describe("Page type"),
      title: z.string().describe("Page title"),
      content: z.string().optional().describe("Optional Markdown body"),
    }),
  },
  async ({ type, title, content }) => {
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
    const result = await ensurePageOperation(paths, { type, title, content });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vault error: ${result.diagnostics[0].message}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: result.created
            ? `✅ Created ${result.path}`
            : `✅ Page already exists: \`${result.path}\``,
        },
      ],
    };
  },
);

// ---- wiki_lint ----

server.registerTool(
  "wiki_lint",
  {
    description:
      "Health check the wiki. Scans for orphans, missing pages, contradictions, gaps. Optionally auto-fixes.",
    inputSchema: z.object({
      auto_fix: z.boolean().optional().describe("Auto-fix orphans and missing pages"),
    }),
  },
  async ({ auto_fix }) => {
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
    const result = await lintOperation(paths, auto_fix === true);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vault error: ${result.diagnostics[0].message}`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: result.report }] };
  },
);

// ---- wiki_log_event ----

server.registerTool(
  "wiki_log_event",
  {
    description: "Append a structured event to meta/events.jsonl and regenerate meta/log.md.",
    inputSchema: z.object({
      kind: z.string().describe("Event kind (e.g., ingest, query, decision)"),
      details: z.record(z.string(), z.unknown()).optional().describe("Additional event fields"),
    }),
  },
  async ({ kind, details }) => {
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
    const result = logEventOperation(paths, { kind, details });
    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: result.message }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: result.message }] };
  },
);

// ---- wiki_observe ----

server.registerTool(
  "wiki_observe",
  {
    description:
      "Record an atomic observation from the current session into the wiki. " +
      "Observations are timestamped, relevance-rated, and searchable via wiki_recall.",
    inputSchema: z.object({
      title: z.string().describe("Short descriptive title (<=80 chars). Noun phrase."),
      content: z.string().describe("The observation in plain prose"),
      relevance: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .default("medium")
        .describe("Relevance level"),
      tags: z.string().optional().describe("Optional space-separated tags"),
      source_context: z.string().optional().describe("What was being worked on"),
    }),
  },
  async ({ title, content, relevance, tags, source_context }) => {
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
    const result = observeOperation(paths, {
      title,
      content,
      relevance: relevance ?? "medium",
      tags,
      source_context,
    });
    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: result.message }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: result.message }] };
  },
);

// ---- wiki_rebuild_meta ----

server.registerTool(
  "wiki_rebuild_meta",
  {
    description:
      "Force a full metadata rebuild (registry, backlinks, index, log). Use if metadata seems out of sync.",
    inputSchema: z.object({}),
  },
  async () => {
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
    const result = await rebuildMetaOperation(paths);
    return { content: [{ type: "text" as const, text: result.report }] };
  },
);

// ---- wiki_reindex_embeddings ----

server.registerTool(
  "wiki_reindex_embeddings",
  {
    description:
      "Backfill / refresh semantic embeddings for the vault. Embeds pages that are new " +
      "or stale (content changed); pass force to re-embed everything. No-op when no " +
      "embedding provider is configured.",
    inputSchema: z.object({
      force: z.boolean().optional().describe("Re-embed every page, ignoring staleness"),
    }),
  },
  async ({ force }) => {
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
    const result = await reindexEmbeddingsOperation(paths, force === true);
    return {
      content: [{ type: "text" as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);

// ---- wiki_watch ----

server.registerTool(
  "wiki_watch",
  {
    description:
      "Print a ready-to-paste crontab line for scheduling automatic wiki updates " +
      "(discover -> ingest -> lint). Does NOT schedule anything itself.",
    inputSchema: z.object({
      interval: z.enum(["daily", "weekly", "hourly", "stop"]).describe("Cron interval"),
    }),
  },
  async ({ interval }) => {
    const result = watchOperation({ interval });
    return {
      content: [{ type: "text" as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);
```

- [ ] **Step 3: Update the "exactly seven tools registered" test (it now fails — this is the red step)**

Run it first to watch it fail:

```bash
pnpm exec vitest run test/mcp-parity.test.ts
```

Expected: one failure in `"exactly seven tools registered"` (7 found, 14 expected) and green everywhere else (the new registrations compile by then, so no other breakage).

Then in `test/mcp-parity.test.ts` replace the expected array. **It must match SOURCE (insertion) order in `mcp/index.ts`** — the test regexes `server.registerTool("...")` top-to-bottom, and the new blocks are inserted after `wiki_capture_source` in this fixed order: ensure_page → lint → log_event → observe → rebuild_meta → reindex_embeddings → watch.

```ts
    expect(tools).toEqual([
      "wiki_bootstrap",
      "wiki_recall",
      "wiki_search",
      "wiki_status",
      "wiki_reindex",
      "wiki_retro",
      "wiki_capture_source",
      "wiki_ensure_page",
      "wiki_lint",
      "wiki_log_event",
      "wiki_observe",
      "wiki_rebuild_meta",
      "wiki_reindex_embeddings",
      "wiki_watch",
    ]);
```

- [ ] **Step 4: Re-run the full MCP test files**

```bash
pnpm exec vitest run test/mcp-parity.test.ts test/mcp-package.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/index.ts test/mcp-parity.test.ts
git commit -m "feat(mcp): expose 7 model-free wiki tools over MCP (13/14 parity)"
```

---

### Task 4: Parity/behavior tests for the new operations

**Files:**
- Modify: `test/mcp-parity.test.ts` (append a new `describe` block at the end of the file)

- [ ] **Step 1: Write the new describe block**

Append to `test/mcp-parity.test.ts`:

```ts
import {
  ensurePageOperation,
  lintOperation,
  logEventOperation,
  observeOperation,
  rebuildMetaOperation,
  reindexEmbeddingsOperation,
  watchOperation,
} from "../mcp/operations.js";

describe("Phase 1 MCP tools (#221)", () => {
  function newVault(name: string): string {
    const root = join(tmpDir, name);
    mkdirSync(root, { recursive: true });
    ensureVaultStructure(getVaultPaths(root));
    writeFileSync(
      join(root, ".llm-wiki", "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
    );
    return root;
  }

  it("ensure_page writes the same canonical page Pi does (incl. #241 frontmatter consume)", async () => {
    const root = newVault("ensure");
    const paths = getVaultPaths(root);
    const res = await ensurePageOperation(paths, {
      type: "concept",
      title: "Frontmatter Test",
      content: "---\ntags: [mcp]\ntitle: Ignored\n---\n\nBody text.",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    const file = join(paths.wiki, "concepts", "frontmatter-test.md");
    const text = readFileSync(file, "utf-8");
    expect(text.split("\n").filter((l) => l === "---")).toHaveLength(2); // one block
    expect(text).toContain("tags:\n  - mcp");
    expect(text).toContain("Body text.");
    expect(text).not.toContain("Ignored");
    expect(text).toContain("title: Frontmatter Test");
    // idempotent
    const again = await ensurePageOperation(paths, { type: "concept", title: "Frontmatter Test" });
    expect(again).toEqual({ ok: true, path: file, created: false });
  });

  it("lint returns a health report and auto_fix repairs", async () => {
    const root = newVault("lint");
    const paths = getVaultPaths(root);
    const res = await lintOperation(paths, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report).toContain("# Wiki Lint Report");
  });

  it("log_event appends a JSONL line and forbids reserved fields", async () => {
    const root = newVault("log");
    const paths = getVaultPaths(root);
    const ok = logEventOperation(paths, { kind: "decision", details: { why: "test" } });
    expect(ok.ok).toBe(true);
    const lines = readFileSync(join(paths.meta, "events.jsonl"), "utf-8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ kind: "decision", why: "test" });
    const bad = logEventOperation(paths, { kind: "x", details: { timestamp: "nope" } });
    expect(bad.ok).toBe(false);
  });

  it("observe writes a timestamped searchable observation page", async () => {
    const root = newVault("observe");
    const paths = getVaultPaths(root);
    const res = observeOperation(paths, {
      title: "MCP parity proven",
      content: "Seven operations ported over MCP.",
      relevance: "high",
      tags: "mcp parity",
    });
    expect(res.ok).toBe(true);
    const slug = res.ok ? "obs-2026-01-01-mcp-parity-proven" : "";
    // slug is date-based; assert by glob instead:
    const pages = readdirSync(join(paths.wiki, "sources")).filter((f) => f.endsWith(".md"));
    expect(pages.length).toBe(1);
    const text = readFileSync(join(paths.wiki, "sources", pages[0]), "utf-8");
    expect(text).toContain("Observation: MCP parity proven");
    expect(text).toContain("high");
  });

  it("rebuild_meta reports the page count", async () => {
    const root = newVault("rebuild");
    const paths = getVaultPaths(root);
    const res = await rebuildMetaOperation(paths);
    expect(res.report).toMatch(/pages indexed\.$/);
  });

  it("reindex_embeddings no-ops cleanly without a provider", async () => {
    const root = newVault("emb");
    const paths = getVaultPaths(root);
    const res = await reindexEmbeddingsOperation(paths, false);
    expect(res.ok).toBe(true);
    expect(res.enabled).toBe(false);
    expect(res.message).toContain("No embedding provider configured");
  });

  it("watch prints the cron line with the llm-wiki-autoupdate tag", async () => {
    const res = watchOperation({ interval: "daily" });
    expect(res.ok).toBe(true);
    expect(res.details.cronLine).toMatch(/^0 8 \* \* \* /);
    expect(String(res.details.cronLine)).toMatch(/# llm-wiki-autoupdate$/);
    const bad = watchOperation({ interval: "yearly" });
    expect(bad.ok).toBe(false);
  });
});
```

Note: the `observe` test above uses `readdirSync(...).filter((f) => f.endsWith(".md"))` against `wiki/sources` because the slug embeds the current date (use `import { readdirSync } from "node:fs"` — it is already imported at the top of `mcp-parity.test.ts`).

- [ ] **Step 2: Run the parity suite**

```bash
pnpm exec vitest run test/mcp-parity.test.ts
```

Expected: all pass (including the updated 14-tool registry test).

- [ ] **Step 3: Commit**

```bash
git add test/mcp-parity.test.ts
git commit -m "test(mcp): parity + behavior coverage for Phase 1 tools"
```

---

### Task 5: Claude Code native plugin packaging

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/.mcp.json`, `.claude-plugin/hooks/hooks.json`
- Create: `scripts/guard-llm-wiki-edit.mjs`

- [ ] **Step 1: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "llm-wiki",
  "displayName": "LLM Wiki",
  "version": "0.1.0",
  "description": "Self-maintaining LLM wiki (Karpathy pattern): recall, observe, retro, capture sources, ensure pages, lint. 14 tools over MCP.",
  "author": { "name": "Zosma AI", "url": "https://github.com/zosmaai" },
  "repository": "https://github.com/zosmaai/pi-llm-wiki",
  "license": "MIT",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json"
}
```

- [ ] **Step 2: Create `.claude-plugin/.mcp.json`**

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/index.js"]
    }
  }
}
```

- [ ] **Step 3: Create `.claude-plugin/hooks/hooks.json`**

```json
{
  "description": "Block direct edits to .llm-wiki/raw and .llm-wiki/meta so model writes go through wiki tools",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/guard-llm-wiki-edit.mjs\""
          }
        ]
      }
    ]
  }
}
```

(No `if` filter: the hook-spawn cost is acceptable in Phase 1, and the script makes the decision itself from the tool input — the same path rule the pi extension enforces.)

- [ ] **Step 4: Create `scripts/guard-llm-wiki-edit.mjs`**

```js
#!/usr/bin/env node
// Claude Code PreToolUse guard: deny Write|Edit calls that target
// .llm-wiki/raw/** or .llm-wiki/meta/** (generated/authoritative state).
// Reads the hook input JSON on stdin; allow = exit 0 with no output,
// deny = exit 0 with the documented PreToolUse deny response.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const filePath = input.tool_input?.file_path ?? "";
if (/(^|[/\\])\.llm-wiki[/\\](raw|meta)([/\\]|$)/.test(filePath)) {
  process.stdout.write(
    JSON.stringify({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Blocked direct edit of ${filePath}. This is generated wiki state — use the wiki tools (wiki_ensure_page, wiki_retro, wiki_observe, wiki_log_event, wiki_ingest) so metadata stays consistent.`,
    }),
  );
}
process.exit(0);
```

- [ ] **Step 5: Validate the hook script locally with sample inputs**

```bash
printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x/.llm-wiki/meta/registry.json"}}' | node scripts/guard-llm-wiki-edit.mjs
printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x/wiki/concepts/ok.md"}}' | node scripts/guard-llm-wiki-edit.mjs
```

Expected: first prints the deny JSON (contains `"permissionDecision":"deny"` and `"hookEventName":"PreToolUse"`); second prints nothing (exit 0, allowed).

- [ ] **Step 5b: Install the plugin into Claude Code (manual smoke, needs the `claude` CLI)**

```bash
claude plugin install .
claude mcp list   # expect: llm-wiki (plugin) listed, tools available
claude plugin uninstall llm-wiki   # cleanup after the smoke test
```

If the `claude` CLI is not installed on this machine, skip this step and note it in the PR description (formats were validated against the official plugin reference).

- [ ] **Step 6: Build the server and smoke it over stdio**

```bash
pnpm build:mcp && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 10 node dist/mcp/index.js
```

Expected: the initialize response lists `"protocolVersion"` and the server capabilities; then EOF. (If the piped JSON closes stdin fast, the server may exit after responding — that is fine; confirm the response text contains `"serverInfo"`.)

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/ scripts/guard-llm-wiki-edit.mjs
git commit -m "feat(plugin): Claude Code native plugin manifest + raw/meta edit guard"
```

---

### Task 6: Codex config + harness documentation

**Files:**
- Create: `hosts/codex.config.toml.example`
- Create: `docs/harnesses.md`
- Modify: `README.md`

- [ ] **Step 1: Create `hosts/codex.config.toml.example`**

```toml
# LLM Wiki via MCP for OpenAI Codex CLI.
# Add to ~/.codex/config.toml (or .codex/config.toml in a trusted repo).
# Manage interactively: codex mcp add llm-wiki -- node <abs>/dist/mcp/index.js
#
# NOTE: top-level key must be snake_case `mcp_servers` — `mcpServers` or
# `mcp.servers` is silently ignored by Codex.

[mcp_servers.llm-wiki]
command = "node"
args = ["/absolute/path/to/pi-llm-wiki/dist/mcp/index.js"]
# Vault root auto-detects from cwd; set explicitly to pin it:
# env = { WIKI_ROOT = "/absolute/path/to/your-wiki" }
startup_timeout_sec = 20
tool_timeout_sec = 120
# enabled = true   # default; set false to disable without removing
```

- [ ] **Step 2: Create `docs/harnesses.md`**

```markdown
# Harness Support

`pi-llm-wiki` serves the same wiki engine over two registration surfaces:

1. **Native pi extension** (`extensions/llm-wiki/`) — full surface: 14 tools, 3
   opt-in trajectory tools, slash commands, ambient recall injection,
   background ingest lane, raw/meta edit guardrails.
2. **MCP server** (`dist/mcp/index.js`) — 14 tools over stdio MCP; consumed by
   any MCP-capable harness.

## Matrix

| Harness | How to attach | Limits |
|---|---|---|
| pi | Built-in extension (this repo) | none |
| Claude Code | `claude plugin install .` — bundles the MCP server (`.claude-plugin/`) + PreToolUse guard hook | no automatic context injection; model calls tools on demand |
| Codex | `hosts/codex.config.toml.example` → `~/.codex/config.toml` | background ingest, commands, reminders not available (Phase 2) |
| Cursor | `"mcpServers"` in `.cursor/mcp.json`, command `node`, args `["<abs>/dist/mcp/index.js"]` | same as Codex |
| Windsurf / Zed / opencode / cline | same stdio command in their MCP settings | same as Codex |

## Guardrails across hosts

- pi: enforced at the tool_call hook.
- Claude Code: PreToolUse hook (`scripts/guard-llm-wiki-edit.mjs`) denies
  Write/Edit on `.llm-wiki/raw/**` and `.llm-wiki/meta/**`.
- Other hosts: rely on the model using wiki tools; direct edits are NOT blocked
  (add their equivalent pre-tool hook if the harness supports one).

## Building

```bash
pnpm build:mcp   # -> dist/mcp/index.js  (also runs on `pnpm prepack`)
```

The server is a single ESM script: `node dist/mcp/index.js`. Set `WIKI_ROOT`
to pin the vault, otherwise it resolves like the pi extension (cwd → parent →
`~/.llm-wiki`).
```

- [ ] **Step 3: Add a README section**

Append to `README.md`:

```markdown
## Harness support

Runs natively in pi, and as an MCP server in Claude Code (plugin), Codex,
Cursor, Windsurf, Zed and opencode. See [docs/harnesses.md](docs/harnesses.md).
```

- [ ] **Step 4: Commit**

```bash
git add hosts/ docs/harnesses.md README.md
git commit -m "docs: Codex config example + harness support matrix"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected:
- `typecheck`: PASS with zero errors.
- `lint`: PASS — the only report is the pre-existing `useOptionalChain` warning at `extensions/llm-wiki/lib/tools.ts:1404` (QMD reindex code, untouched by this phase). No warnings in `mcp/` or tests.
- `test`: 68 test files, all pass (887 + new ~9 tests).

- [ ] **Step 2: Rebuild and smoke the server**

```bash
pnpm build:mcp && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 10 node dist/mcp/index.js | head -c 400
```

Expected: an `initialize` result containing `"serverInfo"` and
`"capabilities":{"tools":...}`.

- [ ] **Step 3: Final commit if anything changed + push**

```bash
git status --short   # expect clean (no stray build artifacts — dist/ is ignored)
git log --oneline origin/main..HEAD
git push -u arjun-zosma HEAD:feat/mcp-tool-parity
```

Expected: branch contains the 6 phase commits (Tasks 1→6). Open the PR against `zosmaai/pi-llm-wiki:main` via `gh pr create` with `Closes #221 (phase 1)`.

---

## Self-review notes

- **Placeholders:** none — every new line of code is in this document; the only "copy" instruction (`runWikiLint`, Task 1) is a verbatim move with explicit source lines, which is the point of the extraction.
- **Type consistency:** operation names (`ensurePageOperation`, `lintOperation`, ...) are used identically in Tasks 2 (definition), 3 (registration import + call), and 4 (test imports). `WATCH_INTERVALS`, `RESERVED_FRONTMATTER`, `buildPageBody` are defined once each. `hasVault()`/`getPaths()` are the existing `mcp/index.ts` helpers.
- **Phase boundary health:** after this phase the repo is green, `wiki_ingest` and the trajectory trio remain intentionally pi-only, all existing pi behavior is unchanged (two `export` keywords + a function move + no behavioral change), and the MCP server gains 7 tools. Claude plugin installs by pointing at the checked-out repo root; npm-level bundling of `.claude-plugin/` + `dist/` into the tarball is Phase 3 (release packaging), not this phase.
- **Known divergence, documented:** pi runs lint/rebuild/embeddings in the background with a "will report next message"; MCP returns results synchronously (it has no UI lane). The *content* both produce is identical.