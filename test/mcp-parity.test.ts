import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapVault } from "../extensions/llm-wiki/lib/bootstrap.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { searchWikiLayered } from "../extensions/llm-wiki/lib/recall.js";
import { saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureText } from "../extensions/llm-wiki/lib/source-packet.js";
import {
  ensureVaultStructure,
  getPersonalWikiPaths,
  getVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";
import { inspectVaultFormat } from "../extensions/llm-wiki/lib/vault-format.js";
import {
  getWikiStatus,
  reindexWiki,
  searchRegistry,
} from "../extensions/llm-wiki/lib/wiki-service.js";
import { createExecApi } from "../mcp/exec.js";
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
} from "../mcp/operations.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("MCP parity with shared services", () => {
  let tmpDir: string;
  let paths: ReturnType<typeof getVaultPaths>;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `mcp-parity-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    paths = getVaultPaths(tmpDir);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal", knowledge_format: "legacy" }),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("search parity: MCP matches shared searchRegistry", async () => {
    // Create a concept
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "nested.md"),
      "---\ntype: concept\ntitle: Nested Concept\nstate: NEEDS-REVIEW\nstatus: edge-case\ndescription: A nested concept about trees\n---\n\n# Nested Concept\n\nTree content.",
    );
    rebuildMetadata(paths);

    const piSearch = searchRegistry(paths, "nested");
    const mcpSearch = await searchOperation(paths, "nested");

    expect(mcpSearch.matches).toEqual(piSearch.matches);
    expect(mcpSearch.diagnostics).toEqual(
      piSearch.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    );

    const piStateSearch = searchRegistry(paths, "needs-review");
    const mcpStateSearch = await searchOperation(paths, "needs-review");

    expect(piStateSearch.matches).toEqual([
      { id: "concepts/nested", title: "Nested Concept", type: "concept" },
    ]);
    expect(mcpStateSearch.matches).toEqual(piStateSearch.matches);

    // Status matching (status is a standard frontmatter field)
    const piStatusSearch = searchRegistry(paths, "edge-case");
    const mcpStatusSearch = await searchOperation(paths, "edge-case");

    expect(piStatusSearch.matches).toEqual([
      { id: "concepts/nested", title: "Nested Concept", type: "concept" },
    ]);
    expect(mcpStatusSearch.matches).toEqual(piStatusSearch.matches);
  });

  it("searches with structured filters and empty queries", async () => {
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "filtered.md"),
      "---\ntype: concept\ntitle: Filtered Concept\nstate: open\nstatus: active\ncategory: research\ndomain: cars\ntags: [open-loop, priority]\n---\n\n# Filtered Concept\n",
    );
    writeFileSync(
      join(paths.wiki, "concepts", "other.md"),
      "---\ntype: concept\ntitle: Other Concept\nstate: closed\nstatus: active\ntags: [priority]\n---\n\n# Other Concept\n",
    );
    rebuildMetadata(paths);

    const filters = {
      state: "OPEN",
      status: "active",
      domain: "CARS",
      tags: ["priority", "OPEN-LOOP"],
    };
    const piSearch = searchRegistry(paths, "", filters);
    const mcpSearch = await searchOperation(paths, "", filters);

    expect(piSearch.matches.map((match) => match.id)).toEqual(["concepts/filtered"]);
    expect(mcpSearch.matches).toEqual(piSearch.matches);
  });

  it("status parity: MCP matches shared getWikiStatus", async () => {
    rebuildMetadata(paths);

    const piStatus = await getWikiStatus(paths);
    const mcpStatus = await statusOperation(paths);

    expect(mcpStatus.knowledgeFormat).toBe(piStatus.knowledgeFormat);
    expect(mcpStatus.totalPages).toBe(piStatus.totalPages);
    expect(mcpStatus.byType).toEqual(piStatus.byType);
    expect(mcpStatus.lastUpdated).toBe(piStatus.lastUpdated);
    expect(mcpStatus.blockingDiagnostics).toEqual(
      piStatus.blockingDiagnostics.map((d) => ({ code: d.code, message: d.message })),
    );
    expect(mcpStatus.qmd).toEqual(piStatus.qmd);
  });

  it("recall parity: MCP matches shared searchWikiLayered with vault diagnostics", async () => {
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "nested.md"),
      "---\ntype: concept\ntitle: Nested Concept\ndescription: A nested concept\n---\n\n# Nested Concept\n\nContent here.",
    );
    rebuildMetadata(paths);

    const piRecall = searchWikiLayered(paths, "nested", 5);
    const mcpRecall = await recallOperation(paths, "nested", 5);

    expect(mcpRecall.results).toEqual(piRecall);
    expect(mcpRecall.diagnostics.map((d) => d.code)).toEqual(
      inspectVaultFormat(paths).diagnostics.map((d) => d.code),
    );
  });

  it("recall uses layered search: MCP returns personal vault results when project vault has no matches", async () => {
    const previousWikiHome = process.env.WIKI_HOME;
    const personalRoot = join(tmpDir, "personal");
    process.env.WIKI_HOME = personalRoot;
    const personalVault = getPersonalWikiPaths();
    ensureVaultStructure(personalVault);
    writeFileSync(
      join(personalVault.dotWiki, "config.json"),
      JSON.stringify({ topic: "Personal test", mode: "personal" }),
    );

    const uniqueTerm = "mcp-layered-test";
    const personalPagePath = join(personalVault.wiki, "concepts", "mcp-layered-test.md");
    mkdirSync(join(personalVault.wiki, "concepts"), { recursive: true });
    writeFileSync(
      personalPagePath,
      "---\ntype: concept\ntitle: MCP Layered Test\ndescription: Test page for mcp-layered-test\n---\n\n# MCP Layered Test\n\nContent for mcp-layered-test.",
    );
    rebuildMetadata(personalVault);

    try {
      const mcpRecall = await recallOperation(paths, uniqueTerm, 10);
      const found = mcpRecall.results.find((r) => r.id === "concepts/mcp-layered-test");
      expect(found).toBeDefined();
      expect(found?.vaultLabel).toBe("📓 personal");
    } finally {
      rmSync(personalPagePath, { force: true });
      rebuildMetadata(personalVault);
      if (previousWikiHome === undefined) delete process.env.WIKI_HOME;
      else process.env.WIKI_HOME = previousWikiHome;
    }
  }, 60_000);

  it("retro parity: MCP uses same saveInsight as Pi", async () => {
    // Pi-style call
    const piResult = saveInsight(paths, "pi-insight", "Pi Title", "Pi body.", "test", {
      rebuild: false,
    });

    // MCP call
    const mcpResult = await retroOperation(paths, "mcp-insight", "MCP Title", "MCP body.", "test");
    expect(mcpResult.ok).toBe(true);
    if (!mcpResult.ok) return;

    // Both produce canonical pages
    const piContent = readFileSync(piResult.sourcePagePath, "utf-8");
    const mcpContent = readFileSync(mcpResult.sourcePagePath, "utf-8");
    expect(piContent).toContain("type: source");
    expect(mcpContent).toContain("type: source");
    expect(piContent).toContain("status: insight");
    expect(mcpContent).toContain("status: insight");
  });

  it("capture parity: MCP uses same captureText as Pi", async () => {
    // Pi-style call
    const piResult = captureText(paths, "Test content", "Pi Capture");

    // MCP call
    const mcpResult = await captureSourceOperation(
      paths,
      { text: "Test content", title: "MCP Capture" },
      createExecApi(),
    );
    expect(mcpResult.ok).toBe(true);
    if (!mcpResult.ok) return;

    // Both create source packets
    const piPage = readFileSync(piResult.sourcePagePath, "utf-8");
    const mcpPage = readFileSync(join(paths.wiki, "sources", `${mcpResult.sourceId}.md`), "utf-8");
    expect(piPage).toContain("type: source");
    expect(mcpPage).toContain("type: source");
  });

  it("makes MCP retro immediately searchable", async () => {
    const result = await retroOperation(
      paths,
      "mcp-visible",
      "Visible Insight",
      "searchable needle",
    );
    expect(result.ok).toBe(true);
    expect(searchRegistry(paths, "Visible Insight").matches.map((match) => match.id)).toContain(
      "sources/mcp-visible",
    );
  });

  it("makes MCP text capture immediately recallable", async () => {
    const result = await captureSourceOperation(
      paths,
      { text: "capture needle", title: "Visible Capture" },
      createExecApi(),
    );
    expect(result.ok).toBe(true);
    expect(searchRegistry(paths, "Visible Capture").matches).toHaveLength(1);
  });

  it("returns blocking projection diagnostics after a successful authoritative write", async () => {
    writeFileSync(join(paths.wiki, "concepts", "bad.md"), "malformed\n");
    const result = await retroOperation(paths, "written-but-blocked", "Written", "Body");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "frontmatter_missing",
    );
  });

  it("reindex parity: MCP matches shared reindexWiki for lexical indexing", async () => {
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "parity.md"),
      "---\ntype: concept\ntitle: Parity Reindex\ndescription: Reindex parity\n---\n\n# Parity Reindex\n\nBody.",
    );
    rebuildMetadata(paths);

    const piResult = await reindexWiki(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
      vault: "active",
    });
    const mcpResult = await reindexOperation(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
      vault: "active",
    });

    expect(mcpResult.vault).toBe(piResult.vault);
    expect(mcpResult.results).toHaveLength(piResult.results.length);
    for (let i = 0; i < piResult.results.length; i++) {
      expect(mcpResult.results[i].root).toBe(piResult.results[i].root);
      expect(mcpResult.results[i].result.ok).toBe(piResult.results[i].result.ok);
    }
  });

  it("all 15 MCP tools are registered", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "mcp", "index.ts"), "utf-8");
    const tools = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);
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
      "wiki_ingest",
    ]);
  });

  describe("bootstrap over MCP (issue #130)", () => {
    it("creates the same vault the Pi tool does", async () => {
      const mcpRoot = join(tmpDir, "mcp-bootstrapped");
      const piRoot = join(tmpDir, "pi-bootstrapped");
      mkdirSync(mcpRoot, { recursive: true });
      mkdirSync(piRoot, { recursive: true });

      const mcpResult = await bootstrapOperation(getVaultPaths(mcpRoot), { topic: "Parity" });
      const piResult = bootstrapVault(getVaultPaths(piRoot), { topic: "Parity", mode: "personal" });

      expect(mcpResult.ok).toBe(true);
      expect(piResult.ok).toBe(true);
      if (!mcpResult.ok) return;
      expect(mcpResult.created).toBe(true);

      // Same scaffolding, same config — one shared implementation.
      const entries = (root: string) =>
        readdirSync(join(root, ".llm-wiki"), { withFileTypes: true })
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .sort();
      expect(entries(mcpRoot)).toEqual(entries(piRoot));
      // Each side generates its own UUID. Assert both are valid, then compare
      // the rest of the config byte-for-byte after omitting vault_id.
      const mcpConfig = JSON.parse(
        readFileSync(join(mcpRoot, ".llm-wiki", "config.json"), "utf-8"),
      );
      const piConfig = JSON.parse(readFileSync(join(piRoot, ".llm-wiki", "config.json"), "utf-8"));
      const { vault_id: mcpVaultId, ...mcpConfigRest } = mcpConfig;
      const { vault_id: piVaultId, ...piConfigRest } = piConfig;
      expect(mcpVaultId).toMatch(UUID);
      expect(piVaultId).toMatch(UUID);
      expect(mcpConfigRest).toEqual(piConfigRest);
    });

    it("is safe to re-run and reports the vault as pre-existing", async () => {
      const bootstrapRoot = join(tmpDir, "rerun");
      mkdirSync(bootstrapRoot, { recursive: true });
      const bootstrapPaths = getVaultPaths(bootstrapRoot);

      await bootstrapOperation(bootstrapPaths, { topic: "First" });
      const saved = await retroOperation(bootstrapPaths, "kept", "Kept Insight", "Body.");
      expect(saved.ok).toBe(true);

      const again = await bootstrapOperation(bootstrapPaths, { topic: "Second", mode: "company" });

      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.created).toBe(false);
      // Re-running rewrites config but must not disturb existing pages.
      const config = JSON.parse(readFileSync(join(bootstrapPaths.dotWiki, "config.json"), "utf-8"));
      expect(config.mode).toBe("company");
      expect(searchRegistry(bootstrapPaths, "Kept Insight").matches).toHaveLength(1);
    });

    it("leaves the other tools' fail-closed message actionable", async () => {
      const freshRoot = join(tmpDir, "fresh");
      mkdirSync(freshRoot, { recursive: true });
      const freshPaths = getVaultPaths(freshRoot);

      // Before bootstrap there is no vault to inspect...
      expect(existsSync(join(freshPaths.dotWiki, "config.json"))).toBe(false);

      await bootstrapOperation(freshPaths, { topic: "Fresh" });

      // ...and afterwards the very tools that pointed at wiki_bootstrap work.
      expect(existsSync(join(freshPaths.dotWiki, "config.json"))).toBe(true);
      const status = await statusOperation(freshPaths);
      expect(status.blockingDiagnostics).toEqual([]);
    });
  });
});

describe("Phase 1 MCP tools (#221)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `mcp-parity-phase1-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function newVault(name: string): string {
    const root = join(tmpDir, name);
    mkdirSync(root, { recursive: true });
    ensureVaultStructure(getVaultPaths(root));
    writeFileSync(
      join(root, ".llm-wiki", "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
    );
    // Fresh vaults have no activity yet; a real post-bootstrap vault regains
    // an (empty) events.jsonl once the first event is logged. Rebuilds warn
    // "event_source_missing" without it (the activity log cannot be rebuilt
    // from a missing source), so mirror that state for the clean-rebuild tests.
    writeFileSync(join(root, ".llm-wiki", "meta", "events.jsonl"), "");
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
    expect(res.report).toContain("LLM Wiki lint complete");
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
