# MCP Tool Parity + Host Distribution — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh semantic embeddings after MCP ingestion, add a Claude Code `SessionStart` wiki notice, and ship a validated npm/Claude marketplace artifact.

**Architecture:** MCP ingestion continues to use `runIngestSynthesis` and the existing embedding sidecar. After each successful deterministic commit, it embeds exactly the pages touched by that commit; embedding failures are repairable and never roll back page writes. Claude Code gets a dependency-free `SessionStart` command hook that reads only a project vault and emits `hookSpecificOutput.additionalContext`. The npm package includes the compiled MCP server and every Claude plugin asset it references. Release versioning uses the latest reachable tag, synchronizes package/plugin metadata, commits it, and tags that commit; the existing tag-triggered GitHub workflow remains the sole publish path.

**Tech Stack:** TypeScript/ESM, Node.js 22+, `@modelcontextprotocol/server`, existing `lib/embeddings.ts` and `lib/ingest-worker.ts`, Claude Code hooks/marketplace manifests, npm `files`/`pack`, Vitest, Biome.

**Roadmap:** `docs/superpowers/plans/2026-09-11-mcp-tool-parity-phase-2-ingest-lane.md` — Multi-phase host expansion, Phase 3.

**Phase:** Phase 3: post-commit embeddings + Claude SessionStart notice + npm/marketplace packaging

**Starting point:** Branch from merged `main` commit `1449685` (PR #246). Do not resurrect `feat/mcp-tool-parity`.

---

## Scope and phase boundary

In scope:

- MCP `wiki_ingest` embedding of source/entity/concept pages written by each successful synthesis.
- A synchronous, repairable MCP embedding path; no detached promise that can be lost when the server exits.
- A Claude Code `SessionStart` hook for project-vault status and pending-source context.
- `llm-wiki.notices: false` and `LLM_WIKI_NOTICES=0` suppression.
- npm inclusion and runtime verification for `dist/mcp/index.js`, `.claude-plugin/**`, `hosts/**`, and both Claude hook scripts.
- A Claude marketplace catalog that installs the published npm package.
- Release-version synchronization between `package.json` and `.claude-plugin/plugin.json`.
- Documentation for marketplace installation, MCP embedding behavior, and task-model settings.

Out of scope:

- Exposing the three opt-in trajectory tools over MCP.
- Replacing heuristic recall with the separate QMD retrieval Phase 3 roadmap.
- A second embedding implementation or a changed embedding-provider contract.
- New publishing automation or registry credentials. `.github/workflows/release.yml` already publishes on `v*` tags; this phase adds no local `npm publish` path.
- Ambient notices for non-Claude MCP clients.

The phase must leave a green checkout, a runnable packed MCP server, and a self-contained Claude marketplace install.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `mcp/operations.ts` | Modify | Add injectable post-commit embedding dependencies, collect committed page IDs, and isolate embedding errors. |
| `test/mcp-ingest-lane.test.ts` | Modify | Test successful embedding and commit preservation when embedding fails. |
| `scripts/claude-session-start.mjs` | Create | Discover a non-personal project vault and emit the Claude SessionStart context. |
| `test/claude-session-start.test.ts` | Create | Exercise active, absent, personal, disabled, env-disabled, malformed, and null-input cases. |
| `.claude-plugin/hooks/hooks.json` | Modify | Register SessionStart beside the existing PreToolUse guard. |
| `.claude-plugin/plugin.json` | Modify | Report 15 MCP tools and align version with package.json. |
| `.claude-plugin/marketplace.json` | Create | Catalog the npm-backed `llm-wiki` plugin. |
| `package.json` | Modify | Pack plugin manifests, host examples, and Claude scripts. |
| `scripts/release.js` | Modify | Use reachable tags, reject collisions, synchronize metadata, commit, and tag. |
| `.github/workflows/release.yml` | Modify | Verify versions against the pushed tag instead of rewriting only package.json. |
| `test/package-structure.test.ts` | Modify | Check manifest and package-file parity. |
| `test/npm-package.test.ts` | Create | Verify actual npm pack contents. |
| `scripts/mcp-smoke.mjs` | Modify | Require all 15 MCP tools, including wiki_ingest. |
| `docs/harnesses.md` | Modify | Document Claude hooks, marketplace installation, and MCP embeddings. |
| `README.md` | Modify | Document all MCP tools and Claude marketplace installation. |
| `docs/configuration.md` | Modify | Document task-model settings for non-pi ingestion. |

---

### Task 1: Specify the MCP embedding contract

**Files:** `test/mcp-ingest-lane.test.ts`

- [ ] **Step 1: Add imports**

```ts
import { readFileSync } from "node:fs";
import { readEmbeddingStore, type Embedder } from "../extensions/llm-wiki/lib/embeddings.js";
import {
  commitSynthesis,
  type CommitResult,
  type RunIngestSynthesisArgs,
} from "../extensions/llm-wiki/lib/ingest-worker.js";
```

Retain the existing fs, lane, and Vitest imports.

- [ ] **Step 2: Make the fixture writable**

The existing fixture calls `ensureVaultStructure` but does not create `.llm-wiki/config.json`. Replace that setup line with:

```ts
const paths = getVaultPaths(root);
ensureVaultStructure(paths);
writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ mode: "personal" }));
```

- [ ] **Step 3: Add deterministic test helpers**

```ts
function committedSynthesis(args: RunIngestSynthesisArgs): CommitResult {
  const result = commitSynthesis(args.paths, args.sourceId, args.manifest, {
    summary: "A deterministic test summary.",
    key_takeaways: ["The test source was committed."],
    entities: [{ title: "Test Entity", description: "A test entity." }],
    concepts: [],
  });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "commit failed");
  return result;
}

function testEmbedder(calls: string[][]): Embedder {
  return {
    model: "test-embedding-model",
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((_, index) => [index + 1, 1]);
    },
  };
}
```

- [ ] **Step 4: Add the successful embedding test**

```ts
it("embeds pages written by each successful MCP synthesis", async () => {
  const paths = getVaultPaths(root);
  const sourceId = "SRC-2026-09-11-001";
  mkdirSync(join(paths.rawSources, sourceId), { recursive: true });
  writeFileSync(join(paths.rawSources, sourceId, "extracted.md"), "test source text");
  writeFileSync(
    join(paths.rawSources, sourceId, "manifest.json"),
    JSON.stringify({ id: sourceId, title: "Embedding Lane Test", format: "text" }),
  );

  const calls: string[][] = [];
  const result = await ingestOperation(paths, {}, {
    runSynthesis: async (args) => committedSynthesis(args),
    embedder: testEmbedder(calls),
  });

  expect(result.isError).toBeUndefined();
  expect(result.report).toContain(`**${sourceId}**: ingested`);
  expect(result.report).toContain("embeddings: 2 embedded");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(2);
  const store = readEmbeddingStore(paths);
  expect(store.entries[`sources/${sourceId}`]).toBeDefined();
  expect(store.entries["entities/test-entity"]).toBeDefined();
});
```

- [ ] **Step 5: Add the failure-isolation test**

```ts
it("keeps a committed synthesis successful when post-commit embedding fails", async () => {
  const paths = getVaultPaths(root);
  const sourceId = "SRC-2026-09-11-002";
  mkdirSync(join(paths.rawSources, sourceId), { recursive: true });
  writeFileSync(join(paths.rawSources, sourceId, "extracted.md"), "test source text");
  writeFileSync(
    join(paths.rawSources, sourceId, "manifest.json"),
    JSON.stringify({ id: sourceId, title: "Embedding Failure Test", format: "text" }),
  );
  const failingEmbedder: Embedder = {
    model: "test-embedding-model",
    embed: async () => { throw new Error("provider offline"); },
  };
  const result = await ingestOperation(paths, {}, {
    runSynthesis: async (args) => committedSynthesis(args),
    embedder: failingEmbedder,
  });

  expect(result.isError).toBeUndefined();
  expect(result.report).toContain(`**${sourceId}**: ingested`);
  expect(result.report).toContain("embedding refresh failed");
  expect(readFileSync(join(paths.wiki, "sources", `${sourceId}.md`), "utf8")).toContain(
    "status: ingested",
  );
});
```

- [ ] **Step 6: Defer execution until implementation is present**

Do not run or commit an expected-failing suite. Continue directly to Task 2; the first commit must occur only after the implementation, focused tests, and typecheck are green.

---

### Task 2: Implement post-commit embeddings

**Files:** `mcp/operations.ts`, `test/mcp-ingest-lane.test.ts`

- [ ] **Step 1: Add imports and dependency seam**

Update the imports:

```ts
import {
  embedPages,
  reindexEmbeddings,
  resolveEmbedder,
  type Embedder,
  type EmbedStats,
} from "../extensions/llm-wiki/lib/embeddings.js";
import { runIngestSynthesis, type CommitResult } from "../extensions/llm-wiki/lib/ingest-worker.js";
```

Insert before `ingestOperation`:

```ts
export interface IngestLaneDeps {
  embedder?: Embedder | null;
  runSynthesis?: typeof runIngestSynthesis;
}

function committedPageIds(committed: CommitResult): string[] {
  return [
    `sources/${committed.sourceId}`,
    ...committed.entitiesCreated.map((slug) => `entities/${slug}`),
    ...committed.entitiesLinked.map((slug) => `entities/${slug}`),
    ...committed.conceptsCreated.map((slug) => `concepts/${slug}`),
    ...committed.conceptsLinked.map((slug) => `concepts/${slug}`),
  ];
}

export async function embedCommittedPages(
  paths: VaultPaths,
  committed: CommitResult,
  embedder: Embedder,
): Promise<EmbedStats> {
  return embedPages(paths, committedPageIds(committed), embedder);
}
```

Use `embedPages`, not `reindexEmbeddings`, because the commit already knows its touched page IDs.

- [ ] **Step 2: Add injectable dependencies**

Change the signature to:

```ts
export async function ingestOperation(
  paths: VaultPaths,
  input: { source_id?: string; batch_size?: number; model?: string },
  deps: IngestLaneDeps = {},
): Promise<{ report: string; isError?: boolean }> {
```

After `const config = loadTaskConfig(paths.root);`, add:

```ts
const runSynthesis = deps.runSynthesis ?? runIngestSynthesis;
const embedder = deps.embedder === undefined ? resolveEmbedder(config) : deps.embedder;
```

Replace the batch-loop call `runIngestSynthesis({` with `runSynthesis({` and preserve every existing argument.

- [ ] **Step 3: Embed after commit and isolate errors**

Immediately after the synthesis call:

```ts
let embeddingNote = "";
if (committed && embedder) {
  try {
    const stats = await embedCommittedPages(paths, committed, embedder);
    embeddingNote = `; embeddings: ${stats.embedded} embedded, ${stats.skipped} fresh`;
  } catch {
    embeddingNote = "; embedding refresh failed — run wiki_reindex_embeddings to retry";
  }
}
```

Append `${embeddingNote}` after the existing wikilink note in the successful summary. Leave the no-synthesis branch unchanged. Do not append an embedding event.

- [ ] **Step 4: Run green checks and commit**

```bash
pnpm exec vitest run test/mcp-ingest-lane.test.ts
pnpm typecheck
git add mcp/operations.ts test/mcp-ingest-lane.test.ts
git commit -m "feat(mcp): refresh embeddings after ingest commits"
```

---

### Task 3: Add the Claude SessionStart notice

**Files:** `scripts/claude-session-start.mjs`, `test/claude-session-start.test.ts`

- [ ] **Step 1: Create the child-process tests**

Create a fixture with `ensureVaultStructure`, `.llm-wiki/config.json`, a registry containing two pages (one skeleton source), and one `raw/sources/SRC-*` directory. Test these cases:

```ts
it("emits SessionStart additionalContext with page and pending counts", () => {
  const output = JSON.parse(runHook({ cwd: root, source: "startup" }));
  expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(output.hookSpecificOutput.additionalContext).toContain("Indexed pages: 2");
  expect(output.hookSpecificOutput.additionalContext).toContain("Pending source packets: 1");
});

it("does not treat WIKI_HOME as a project vault", () => {
  const sandbox = mkdtempSync(join(rootDir, "tmp", "claude-session-personal-"));
  const personal = join(sandbox, "home", "personal");
  const project = join(personal, "projects", "empty");
  mkdirSync(join(personal, ".llm-wiki"), { recursive: true });
  writeFileSync(join(personal, ".llm-wiki", "config.json"), "{}");
  mkdirSync(project, { recursive: true });
  expect(runHook({ cwd: project, source: "startup" }, { WIKI_HOME: personal })).toBe("");
});

it("keeps notice and process switches independently testable", () => {
  const active = createVault();
  mkdirSync(join(active, ".pi"), { recursive: true });
  writeFileSync(join(active, ".pi", "settings.json"), JSON.stringify({ "llm-wiki": { notices: false } }));
  expect(runHook({ cwd: active, source: "startup" }, { LLM_WIKI_NOTICES: "1" })).toBe("");

  writeFileSync(join(active, ".pi", "settings.json"), JSON.stringify({ "llm-wiki": { notices: true } }));
  expect(runHook({ cwd: active, source: "startup" }, { LLM_WIKI_NOTICES: "0" })).toBe("");
});

it("is silent for no vault, malformed input, and null input", () => {
  const empty = mkdtempSync(join(rootDir, "tmp", "claude-session-empty-"));
  expect(runHook({ cwd: empty, source: "startup" })).toBe("");
  expect(execFileSync(process.execPath, [script], { input: "not-json", encoding: "utf8" })).toBe("");
  expect(execFileSync(process.execPath, [script], { input: "null", encoding: "utf8" })).toBe("");
});
```

Use `execFileSync`, `mkdtempSync`, `rmSync`, and the existing `rootDir` helper; clean every temporary root in `afterEach`.

- [ ] **Step 2: Implement `scripts/claude-session-start.mjs`**

```js
#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }
function readStdin() {
  return new Promise((done) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => done(input));
  });
}
function projectVaultRoot(cwd) {
  const configured = process.env.WIKI_ROOT?.trim();
  if (configured) {
    const root = resolve(configured);
    return existsSync(join(root, ".llm-wiki", "config.json")) ? root : undefined;
  }
  const personalBase = process.env.WIKI_HOME?.trim() || homedir();
  const personalRoot = resolve(join(personalBase, ".llm-wiki"));
  let current = resolve(cwd || process.cwd());
  while (true) {
    const candidate = join(current, ".llm-wiki");
    if (resolve(candidate) !== personalRoot && existsSync(join(candidate, "config.json"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}
function noticesDisabled(root) {
  if (process.env.LLM_WIKI_NOTICES === "0") return true;
  for (const directory of [".pi", ".omp"]) {
    const settings = readJson(join(root, directory, "settings.json"));
    if (settings?.["llm-wiki"]?.notices === false) return true;
  }
  return false;
}
function vaultStats(root) {
  const vault = join(root, ".llm-wiki");
  const registry = readJson(join(vault, "meta", "registry.json")) ?? { pages: {} };
  const pages = registry.pages && typeof registry.pages === "object" ? registry.pages : {};
  const sourceDir = join(vault, "raw", "sources");
  const packets = existsSync(sourceDir) ? readdirSync(sourceDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("SRC-")).map((e) => e.name) : [];
  const ingested = new Set(Object.entries(pages).filter(([id, page]) => {
    const value = page && typeof page === "object" ? page : {};
    return id.startsWith("sources/") && value.type === "source" && value.status !== "skeleton";
  }).map(([id]) => id.slice("sources/".length)));
  return { indexedPages: Object.keys(pages).length, pendingSources: packets.filter((id) => !ingested.has(id)).length };
}
const rawInput = await readStdin();
let event;
try { event = JSON.parse(rawInput || "{}"); } catch { process.exit(0); }
if (!event || typeof event !== "object" || Array.isArray(event)) process.exit(0);
const root = projectVaultRoot(event.cwd || process.cwd());
if (!root || noticesDisabled(root)) process.exit(0);
const stats = vaultStats(root);
const pending = stats.pendingSources === 0 ? "No source packets are waiting for ingestion." : `Pending source packets: ${stats.pendingSources}.`;
const additionalContext = [`🧠 LLM Wiki active at ${root}.`, `Indexed pages: ${stats.indexedPages}.`, pending, "Use wiki_recall for relevant context, wiki_capture_source to preserve new material, and wiki_ingest to synthesize captured sources.", "Use wiki tools for .llm-wiki/raw and .llm-wiki/meta; those paths are immutable/generated."].join(" ");
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
```

Malformed/non-object input and missing vaults produce no output and exit 0. Malformed registries produce empty counts; malformed settings fail open. An explicit `WIKI_ROOT` is allowed, but ancestor walking excludes `WIKI_HOME/.llm-wiki` or `$HOME/.llm-wiki`.

- [ ] **Step 3: Run green checks and commit**

```bash
pnpm exec vitest run test/claude-session-start.test.ts
node --check scripts/claude-session-start.mjs
git add scripts/claude-session-start.mjs test/claude-session-start.test.ts
git commit -m "feat(claude): add project wiki SessionStart notice"
```

---

### Task 4: Wire Claude and update docs

**Files:** `.claude-plugin/hooks/hooks.json`, `docs/harnesses.md`, `README.md`, `docs/configuration.md`

- [ ] **Step 1: Register the hooks**

Use this `.claude-plugin/hooks/hooks.json`:

```json
{
  "description": "Surface project wiki context at Claude session start and block direct edits to raw/meta",
  "hooks": {
    "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/claude-session-start.mjs\"" }] }],
    "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/guard-llm-wiki-edit.mjs\"" }] }]
  }
}
```

- [ ] **Step 2: Update `docs/harnesses.md`**

Update the Claude row to mention the MCP server, raw/meta guard, and project-vault SessionStart notice with no personal fallback. Add the marketplace commands:

```text
/plugin marketplace add https://github.com/zosmaai/pi-llm-wiki
/plugin install llm-wiki@zosmaai
/reload-plugins
```

Document that the npm package contains `dist/mcp/index.js`, `.claude-plugin/.mcp.json`, both hook scripts, and both manifests. Document project-vault-only activation, page/pending-source counts, `notices: false`, `LLM_WIKI_NOTICES=0`, and no personal fallback. Add:

```md
After a successful MCP synthesis commit, the server embeds the source page and
all entity/concept pages touched by that commit when `embeddingProvider` and
embedding credentials are configured. The request is synchronous so the server
cannot exit with work silently lost. A provider failure never rolls back pages;
the response points to `wiki_reindex_embeddings` for repair.
```

- [ ] **Step 3: Update `docs/configuration.md`**

Add after `taskModel`:

```md
| `taskModelBaseUrl` | — | OpenAI-compatible base URL used by the MCP ingest lane |
| `taskModelApiKey` | — | Literal MCP task-model key; prefer `taskModelApiKeyEnv` |
| `taskModelApiKeyEnv` | — | Environment variable name holding the MCP task-model key |
```

Add that these are additive MCP-host settings and pi still uses its session model registry.

- [ ] **Step 4: Complete the README MCP tool table**

The README claims 15 tools but currently lists only seven. Replace that table with all 15 names and descriptions, matching `mcp/index.ts`:

```md
| Tool | Description |
|------|-------------|
| `wiki_bootstrap` | Initialize a vault |
| `wiki_recall` | Search relevant wiki pages |
| `wiki_search` | Search the registry |
| `wiki_status` | Show wiki health and counts |
| `wiki_retro` | Save an atomic insight |
| `wiki_capture_source` | Capture a source packet |
| `wiki_ingest` | Synthesize captured sources synchronously over the configured task model |
| `wiki_reindex` | Rebuild/repair QMD indexes |
| `wiki_ensure_page` | Safely create a canonical page |
| `wiki_lint` | Run deterministic health checks |
| `wiki_log_event` | Append an activity event |
| `wiki_observe` | Save a timestamped observation |
| `wiki_rebuild_meta` | Rebuild metadata projections |
| `wiki_reindex_embeddings` | Refresh semantic embeddings |
| `wiki_watch` | Print an update cron line |
```

Add the same marketplace installation commands below the MCP usage section.

- [ ] **Step 5: Validate and commit**

```bash
node -e 'const h=require("./.claude-plugin/hooks/hooks.json"); if(!h.hooks.SessionStart||!h.hooks.PreToolUse) process.exit(1)'
git add .claude-plugin/hooks/hooks.json docs/harnesses.md docs/configuration.md README.md
git commit -m "docs(claude): document SessionStart and marketplace install"
```

---

### Task 5: Make manifests and release metadata correct

**Files:** `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `scripts/release.js`, `.github/workflows/release.yml`

- [ ] **Step 1: Synchronize current plugin metadata**

Keep the existing plugin fields, change its description to `15 tools over MCP`, and run:

```bash
node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const path=".claude-plugin/plugin.json"; const plugin=JSON.parse(fs.readFileSync(path,"utf8")); plugin.version=pkg.version; plugin.description="Self-maintaining LLM wiki (Karpathy pattern): recall, observe, retro, capture sources, ensure pages, lint, and ingest. 15 tools over MCP."; fs.writeFileSync(path,JSON.stringify(plugin,null,2)+"\n")'
node -e 'const p=require("./package.json"); const m=require("./.claude-plugin/plugin.json"); if(m.version!==p.version) process.exit(1)'
```

- [ ] **Step 2: Create `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "zosmaai",
  "version": "1.0.0",
  "description": "Zosma AI plugins for knowledge work and durable project memory.",
  "owner": { "name": "Zosma AI", "url": "https://github.com/zosmaai" },
  "plugins": [{
    "name": "llm-wiki",
    "displayName": "LLM Wiki",
    "description": "A self-maintaining, Obsidian-compatible LLM wiki with MCP tools and Claude guardrails.",
    "source": { "source": "npm", "package": "@zosmaai/pi-llm-wiki" },
    "category": "productivity",
    "keywords": ["wiki", "memory", "mcp", "knowledge-base"]
  }]
}
```

- [ ] **Step 3: Extend the npm allow-list**

Add `.claude-plugin`, `hosts`, `scripts/claude-session-start.mjs`, and `scripts/guard-llm-wiki-edit.mjs` to `package.json#files`; retain the existing dist/mcp/extensions/skills/prompts/commands/docs/migration entries and do not pack tests or vaults.

- [ ] **Step 4: Make `release.js` tag-aware**

Use reachable tags only:

```js
const releaseTags = execSync("git tag --merged HEAD --list 'v*' --sort=-version:refname", {
  encoding: "utf-8",
})
  .split(/\r?\n/)
  .map((tag) => tag.trim())
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
const latestTagVersion = releaseTags[0]?.slice(1) ?? current;
const [major, minor, patch] = latestTagVersion.split(".").map(Number);
```

After calculating `next`, before changing files:

```js
if (execSync(`git tag --list "v${next}"`, { encoding: "utf-8" }).trim()) {
  console.error(`Error: release tag v${next} already exists`);
  process.exit(1);
}
```

After `pkg.version = next`, update `.claude-plugin/plugin.json` to `next`. Replace the tag-only ending with:

```js
execSync("git add package.json CHANGELOG.md .claude-plugin/plugin.json", { stdio: "inherit" });
execSync(`git commit -m "chore(release): v${next}"`, { stdio: "inherit" });
execSync(`git tag v${next}`, { stdio: "inherit" });
console.log(`\n✅ Committed and tagged v${next}`);
console.log("Push main and the tag; the existing release workflow publishes the package:");
console.log(`  git push origin main v${next}`);
```

Do not add a local `npm publish` command. The latest reachable tag is authoritative because the current package version lags the newest tag; the collision check prevents an already-existing target tag.

- [ ] **Step 5: Verify versions in `.github/workflows/release.yml`**

Replace the workflow's `Update package.json version` step with:

```yaml
      - name: Verify package and plugin versions
        run: |
          node - <<'NODE'
          const fs = require("node:fs");
          const expected = process.env.RELEASE_VERSION;
          const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
          const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8"));
          if (pkg.version !== expected) throw new Error(`package.json is ${pkg.version}, tag is ${expected}`);
          if (plugin.version !== expected) throw new Error(`plugin.json is ${plugin.version}, tag is ${expected}`);
          NODE
        env:
          RELEASE_VERSION: ${{ steps.version.outputs.VERSION }}
```

Keep the existing tag-triggered `pnpm publish` step. Update its stale release-body count to `14 always-on Pi tools, 3 opt-in trajectory tools, and 15 MCP tools`.

- [ ] **Step 6: Syntax-check and commit**

```bash
node --check scripts/release.js
node --check scripts/claude-session-start.mjs
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json scripts/release.js .github/workflows/release.yml
git commit -m "feat(package): ship Claude plugin and marketplace assets"
```

Do not execute `release:patch` on this feature branch.

---

### Task 6: Test the npm tarball and packed MCP surface

**Files:** `test/package-structure.test.ts`, `test/npm-package.test.ts`, `scripts/mcp-smoke.mjs`

- [ ] **Step 1: Add package metadata assertions**

Add a test that reads package/plugin/marketplace JSON and asserts plugin version equals package version, plugin paths equal `./.mcp.json` and `./hooks/hooks.json`, package files contain all four new asset entries, and the marketplace contains `{ name: "llm-wiki", source: { source: "npm", package: pkg.name } }`.

- [ ] **Step 2: Add the actual tarball test**

Create `test/npm-package.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { rootDir } from "./helpers.js";

describe("npm package boundary", () => {
  it("packs the runnable MCP server and Claude assets", () => {
    execFileSync("pnpm", ["build:mcp"], { cwd: rootDir, stdio: "ignore" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: rootDir, encoding: "utf8" });
    const report = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(report[0].files.map(({ path }) => path.replaceAll("\\", "/")));
    for (const required of [
      "dist/mcp/index.js", "dist/package.json", ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json", ".claude-plugin/.mcp.json",
      ".claude-plugin/hooks/hooks.json", "scripts/claude-session-start.mjs",
      "scripts/guard-llm-wiki-edit.mjs", "hosts/codex.config.toml.example",
    ]) expect(packed, required).toContain(required);
  }, 60_000);
});
```

- [ ] **Step 3: Replace the smoke tool list with all 15 tools**

In `scripts/mcp-smoke.mjs`, replace the entire `REQUIRED_TOOLS` declaration with:

```js
const REQUIRED_TOOLS = [
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
  "wiki_ingest",
];
```

- [ ] **Step 4: Run package tests and commit**

```bash
pnpm exec vitest run test/package-structure.test.ts test/npm-package.test.ts test/mcp-package.test.ts
git add test/package-structure.test.ts test/npm-package.test.ts scripts/mcp-smoke.mjs
git commit -m "test(package): verify packed MCP and Claude assets"
```

---

### Task 7: Complete the phase gate

- [ ] **Step 1: Run quality checks**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

- [ ] **Step 2: Build and smoke-test MCP**

```bash
pnpm build:mcp
node scripts/mcp-smoke.mjs dist/mcp/index.js
```

Expected: the packed entry starts over stdio, exposes all 15 tools including `wiki_ingest`, and writes no diagnostic to stdout.

- [ ] **Step 3: Inspect npm contents without publishing**

```bash
npm pack --dry-run --ignore-scripts --json > /tmp/pi-llm-wiki-pack.json
node -e 'const r=require("/tmp/pi-llm-wiki-pack.json")[0]; for (const p of ["dist/mcp/index.js",".claude-plugin/plugin.json",".claude-plugin/marketplace.json","scripts/claude-session-start.mjs"]) if(!r.files.some(f=>f.path===p)) process.exit(1); console.log("required package assets present")'
```

- [ ] **Step 4: Review against current remote main**

```bash
git status --short
git log --oneline --max-count=8
git fetch origin main --quiet
git diff origin/main...HEAD --stat
```

Expected: only planned files changed, `dist/` remains ignored, and the branch is based on current `origin/main`. Do not run `release:patch` on the phase branch.

---

## Final verification matrix

| Requirement | Evidence |
|---|---|
| Successful MCP commits refresh touched pages | Deterministic post-commit embedding test |
| Embedding failures preserve page commits | Failure-isolation test |
| Claude emits the documented SessionStart shape | Child-process hook test |
| Personal vault cannot leak into project context | `WIKI_HOME` sandbox regression and corrected ancestor exclusion |
| Notice switches are independently honored | `notices: false` with `LLM_WIKI_NOTICES=1`; `notices: true` with `LLM_WIKI_NOTICES=0` |
| Plugin assets are wired and packed | Hook manifest and npm pack test |
| Plugin/package versions agree | Source assertion and release synchronization |
| Marketplace installs the published package | Exact npm marketplace source |
| Packed MCP exposes the full merged surface | 15-entry smoke list and package test |
| No duplicate publishing path is introduced | Existing tag workflow remains the sole publish step |

This plan intentionally stops at **Phase 3: post-commit embeddings + Claude SessionStart notice + npm/marketplace packaging**. Trajectory-tool MCP parity and the separate QMD retrieval roadmap require separate plans.
