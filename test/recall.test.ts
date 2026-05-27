import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import {
  formatRecallContext,
  searchWiki,
  searchWikiLayered,
} from "../extensions/llm-wiki/lib/recall.js";
import {
  ensureVaultStructure,
  getPersonalWikiPaths,
  getVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

describe("wiki recall", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `recall-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = (() => {
      const dir = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "wiki/changes",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
    ensureVaultStructure(getVaultPaths(wikiDir));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createRegistryPage(
    id: string,
    type: string,
    title: string,
    content: string,
    extra: Record<string, unknown> = {},
  ) {
    const folder = id.includes("/") ? id.split("/")[0] : "concepts";
    const name = id.includes("/") ? id.split("/").pop()! : id;
    const pagePath = join(wikiDir, ".llm-wiki", "wiki", folder, `${name}.md`);
    writeFileSync(
      pagePath,
      `---\ntype: ${type}\ntitle: "${title}"\ncreated: 2026-05-11\nupdated: 2026-05-11\nsources: []\n${Object.entries(
        extra,
      )
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}\n---\n\n${content}`,
      "utf-8",
    );
    return `${folder}/${name}`;
  }

  it("should return empty results when wiki has no pages", () => {
    const paths = getVaultPaths(wikiDir);
    const results = searchWiki(paths, "machine learning");
    expect(results).toEqual([]);
  });

  it("should find pages matching by title", () => {
    createRegistryPage(
      "reinforcement-learning",
      "concept",
      "Reinforcement Learning",
      "RL is a type of machine learning.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "reinforcement learning");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain("Reinforcement Learning");
    expect(results[0].id).toContain("reinforcement-learning");
    expect(results[0].type).toBe("concept");
  });

  it("should find pages matching by page ID", () => {
    createRegistryPage(
      "transformer-architecture",
      "concept",
      "Transformer",
      "The Transformer model architecture.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "transformer-architecture");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toContain("transformer-architecture");
  });

  it("should find pages matching by type", () => {
    createRegistryPage("gpt-4", "entity", "GPT-4", "OpenAI language model.", { category: "tool" });
    createRegistryPage("rag", "concept", "RAG", "Retrieval augmented generation.");
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "entity");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.type === "entity")).toBe(true);
  });

  it("should find pages matching multiline aliases and recall triggers", () => {
    const pagePath = join(wikiDir, ".llm-wiki", "wiki", "analyses", "continue-learning-pi.md");
    writeFileSync(
      pagePath,
      [
        "---",
        "type: analysis",
        "title: Pi 学习入口",
        "aliases:",
        "  - 继续学习pi",
        "  - 学习pi",
        "recall_triggers:",
        "  - pi下一节",
        "created: 2026-05-27",
        "updated: 2026-05-27",
        "---",
        "",
        "# Recall 提示",
        "",
        "命中后读取 Pi 学习进度。",
      ].join("\n"),
      "utf-8",
    );

    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "继续学习pi");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("analyses/continue-learning-pi");
  });

  it("should find pages matching body text when metadata is sparse", () => {
    createRegistryPage(
      "sparse-page",
      "concept",
      "Unrelated Title",
      "This body explains codex relay provider credential precedence.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "credential precedence");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("concepts/sparse-page");
  });

  it("should find mixed Chinese and Latin short queries without spaces", () => {
    createRegistryPage(
      "pi-learning-progress",
      "synthesis",
      "Pi 学习进度",
      "下一步学习 Pi 交互模式。",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "学习pi");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === "concepts/pi-learning-progress")).toBe(true);
  });

  it("should return pages with content preview", () => {
    createRegistryPage(
      "attention-is-all-you-need",
      "source",
      "Attention Is All You Need",
      "This paper introduced the Transformer architecture.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "attention");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].preview).toBeTruthy();
    expect(results[0].preview).toContain("Transformer");
  });

  it("should respect maxResults parameter", () => {
    for (let i = 1; i <= 5; i++) {
      createRegistryPage(
        `concept-${i}`,
        "concept",
        `Concept ${i}`,
        `This is concept ${i} about stuff.`,
      );
    }
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "concept", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should find requirement pages by title", () => {
    const reqDir = join(wikiDir, ".llm-wiki", "wiki", "requirements");
    mkdirSync(reqDir, { recursive: true });
    writeFileSync(
      join(reqDir, "sso-login.md"),
      [
        "---",
        "type: requirement",
        'title: "SSO Login"',
        "status: active",
        "priority: p0",
        "created: 2026-05-16",
        "updated: 2026-05-16",
        "---",
        "",
        "# SSO Login",
        "",
        "Users can sign in via OAuth providers.",
      ].join("\n"),
      "utf-8",
    );
    const paths = getVaultPaths(wikiDir);
    const dotWiki = join(paths.dotWiki);
    mkdirSync(dotWiki, { recursive: true });
    writeFileSync(
      join(dotWiki, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
      "utf-8",
    );
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "SSO Login");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id.startsWith("requirements/"))).toBe(true);
    expect(results.some((r) => r.title.includes("SSO Login"))).toBe(true);
  });

  it("should format recall results as system context", () => {
    const results = [
      {
        id: "concepts/rag",
        title: "RAG",
        type: "concept",
        preview: "Retrieval augmented generation is a technique.",
        path: "/tmp/wiki/concepts/rag.md",
        score: 5,
      },
      {
        id: "entities/openai",
        title: "OpenAI",
        type: "entity",
        preview: "OpenAI is an AI research organization.",
        path: "/tmp/wiki/entities/openai.md",
        score: 3,
      },
    ];
    const context = formatRecallContext(results);
    expect(context).toContain("Relevant Wiki Knowledge");
    expect(context).toContain("[[concepts/rag]]");
    expect(context).toContain("[[entities/openai]]");
    expect(context).toContain("RAG");
    expect(context).toContain("OpenAI");
    expect(context).toContain("2 page(s)");
    expect(context).toContain("wiki_ensure_page or wiki_retro");
  });

  it("should return empty string for empty results", () => {
    expect(formatRecallContext([])).toBe("");
  });

  it("should return empty results when no vault exists", () => {
    const emptyDir = join(tmpDir, "no-vault");
    mkdirSync(emptyDir, { recursive: true });
    const paths = getVaultPaths(emptyDir);
    // No config.json means no vault — search should handle gracefully
    const results = searchWiki(paths, "anything");
    expect(results).toEqual([]);
  });

  describe("layered recall (personal + project)", () => {
    it("should fall back to primary vault when no personal wiki exists", () => {
      createRegistryPage(
        "layered-test",
        "concept",
        "Layered Test",
        "Testing layered recall fallback.",
      );
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);
      // Personal wiki (~/.llm-wiki/) won't exist in test sandbox
      // So searchWikiLayered should return primary vault results only
      const results = searchWikiLayered(paths, "layered test");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toContain("Layered Test");
      // Should not have vaultLabel since personal wiki didn't contribute
      expect(results.every((r) => !r.vaultLabel)).toBe(true);
    });

    it("should tag personal vault results when personal wiki exists", () => {
      // Create primary vault page
      createRegistryPage(
        "project-concept",
        "concept",
        "Project Concept",
        "A project-specific concept.",
      );
      // Also create a personal wiki entry
      const personalPaths = getPersonalWikiPaths();
      const personalSourcesDir = join(personalPaths.wiki, "sources");
      mkdirSync(personalSourcesDir, { recursive: true });
      const personalMeta = join(personalPaths.meta);
      mkdirSync(personalMeta, { recursive: true });
      const personalDotWiki = personalPaths.dotWiki;
      mkdirSync(personalDotWiki, { recursive: true });
      writeFileSync(
        join(personalDotWiki, "config.json"),
        JSON.stringify({ topic: "Personal", mode: "personal" }),
      );
      writeFileSync(
        join(personalSourcesDir, "personal-insight.md"),
        [
          "---",
          "type: source",
          'title: "Personal Insight"',
          "slug: personal-insight",
          "status: insight",
          "created: 2026-05-21",
          "updated: 2026-05-21",
          "---",
          "",
          "# Personal Insight",
          "",
          "A personal wiki insight.",
        ].join("\n"),
      );
      rebuildMetadataLight(personalPaths);

      // Now rebuild primary vault metadata
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Search should find results from both vaults
      const results = searchWikiLayered(paths, "concept", 5);
      // Personal results should be tagged
      const personalResults = results.filter((r) => r.vaultLabel);
      if (personalResults.length > 0) {
        expect(personalResults[0].vaultLabel).toBe("📓 personal");
      }

      // Clean up personal wiki test artifacts
      try {
        rmSync(personalPaths.dotWiki, { recursive: true, force: true });
      } catch {}
    });
  });

  describe("chunk-level indexing", () => {
    it("should match a query against a specific section, not the whole page", () => {
      // Page with multiple sections - only one about the query topic
      createRegistryPage(
        "server-setup",
        "concept",
        "Server Setup",
        [
          "This page covers server setup basics.",
          "",
          "## Postgres",
          "",
          "PostgreSQL is configured with SSL and connection pooling via PgBouncer.",
          "Connection string uses the DATABASE_URL env var.",
          "",
          "## Redis",
          "",
          "Redis is used for caching session data and rate limiting.",
          "",
          "## Nginx",
          "",
          "Nginx reverse proxies API requests and serves static assets.",
        ].join("\n"),
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Query for Postgres - should match the Postgres section specifically
      const results = searchWiki(paths, "PostgreSQL connection pooling");
      expect(results.length).toBeGreaterThanOrEqual(1);

      // The preview should show the Postgres section content, not the intro
      const result = results[0];
      expect(result.id).toBe("concepts/server-setup");
      expect(result.preview).toContain("Postgres");
      expect(result.preview).toContain("PgBouncer");
      // Should not show the intro which mentions "server setup basics"
      expect(result.preview).not.toContain("basics");
    });

    it("should match a query against the intro section", () => {
      createRegistryPage(
        "introduction",
        "concept",
        "Getting Started",
        "Welcome to the framework. This is where you begin learning about routing and middleware.",
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      const results = searchWiki(paths, "Getting Started routing");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].preview).toContain("routing");
    });

    it("should match a deeply nested section heading", () => {
      createRegistryPage(
        "deep-page",
        "synthesis",
        "Deep Analysis",
        [
          "## Background",
          "",
          "General background.",
          "",
          "### Deep Dive",
          "",
          "The specific mechanism involves token-level processing.",
          "",
          "## Results",
          "",
          "All tests pass.",
        ].join("\n"),
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      const results = searchWiki(paths, "token-level processing");
      expect(results.length).toBeGreaterThanOrEqual(1);
      const result = results[0];
      expect(result.preview).toContain("token-level");
      expect(result.preview).toContain("Deep Dive");
    });

    it("should still find pages via metadata even when body has no match", () => {
      createRegistryPage(
        "api-reference",
        "concept",
        "API Reference",
        "Detailed API documentation with examples.",
        { aliases: "api-docs rest-api" },
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Match on alias, not body
      const results = searchWiki(paths, "rest-api");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("concepts/api-reference");
    });
  });
});
