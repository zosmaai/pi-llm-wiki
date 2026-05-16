import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import { formatRecallContext, searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

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
      },
      {
        id: "entities/openai",
        title: "OpenAI",
        type: "entity",
        preview: "OpenAI is an AI research organization.",
        path: "/tmp/wiki/entities/openai.md",
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
});
