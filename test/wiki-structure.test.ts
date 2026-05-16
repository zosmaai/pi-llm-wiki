import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { createConfig, createWikiPage, readFile } from "./helpers.js";

describe("wiki directory structure", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `wiki-structure-${Date.now()}`);
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
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should have all required directories", () => {
    expect(existsSync(join(wikiDir, ".llm-wiki", "raw", "articles"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "raw", "papers"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "raw", "notes"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "entities"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "concepts"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "sources"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "syntheses"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "changes"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", "outputs"))).toBe(true);
    expect(existsSync(join(wikiDir, ".llm-wiki", ".discoveries"))).toBe(true);
  });

  it("should create source pages from ingested files", () => {
    createConfig(wikiDir);
    createWikiPage(
      wikiDir,
      "sources",
      "test-article.md",
      "---\ntype: source\nformat: article\nraw_path: .llm-wiki/raw/articles/test-article.md\ningested: 2026-04-27\ntopics: [ai]\n---\n\n# Test Article\n\n## Summary\nAI content.\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "sources", "test-article.md"));
    expect(content).toContain("type: source");
    expect(content).toContain("raw_path: .llm-wiki/raw/articles/test-article.md");
  });

  it("should create entity pages with correct format", () => {
    createWikiPage(
      wikiDir,
      "entities",
      "test-entity.md",
      "---\ntype: entity\ncategory: person\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: [.llm-wiki/raw/articles/test.md]\n---\n\n# Person\n\n## Links\n- [[related-concept]]\n\n## Sources\n- [test](../.llm-wiki/raw/articles/test.md)\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "entities", "test-entity.md"));
    expect(content).toContain("type: entity");
    expect(content).toContain("category: person");
    expect(content).toContain("[[related-concept]]");
  });

  it("should create concept pages with correct format", () => {
    createWikiPage(
      wikiDir,
      "concepts",
      "test-concept.md",
      "---\ntype: concept\ndomain: engineering\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: []\n---\n\n# Test Concept\n\n## Links\n- [[other-concept]]\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "concepts", "test-concept.md"));
    expect(content).toContain("type: concept");
    expect(content).toContain("domain: engineering");
    expect(content).toContain("[[other-concept]]");
  });

  it("should create synthesis pages with correct format", () => {
    createWikiPage(
      wikiDir,
      "syntheses",
      "comparison.md",
      "---\ntype: synthesis\ntopic: comparison\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources_count: 2\n---\n\n# Comparison\n\n## Sources Used\n- [[source-1]]\n- [[source-2]]\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "syntheses", "comparison.md"));
    expect(content).toContain("type: synthesis");
    expect(content).toContain("sources_count: 2");
    expect(content).toContain("[[source-1]]");
  });

  describe("requirements page type", () => {
    it("should create requirement pages with correct frontmatter", () => {
      const reqDir = join(wikiDir, ".llm-wiki", "wiki", "requirements");
      mkdirSync(reqDir, { recursive: true });
      createWikiPage(
        wikiDir,
        "requirements",
        "sso-login.md",
        "---\ntype: requirement\nstatus: active\npriority: p0\nsource_id: SRC-2026-05-16-001\ndepends_on: []\ncreated: 2026-05-16\nupdated: 2026-05-16\n---\n\n# SSO Login\n\n## Description\nUsers can sign in with Google or GitHub.\n\n## Acceptance Criteria\n- [ ] Google OAuth button works\n- [ ] GitHub OAuth button works\n\n## Dependencies\nNone.\n\n## Sources\n- [[sources/SRC-2026-05-16-001]]\n",
      );
      const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "requirements", "sso-login.md"));
      expect(content).toContain("type: requirement");
      expect(content).toContain("status: active");
      expect(content).toContain("priority: p0");
      expect(content).toContain("source_id: SRC-2026-05-16-001");
      expect(content).toContain("depends_on: []");
      expect(content).toContain("## Acceptance Criteria");
      expect(content).toContain("- [ ] Google OAuth button works");
    });

    it("should create requirement pages with dependency tracking", () => {
      const reqDir = join(wikiDir, ".llm-wiki", "wiki", "requirements");
      mkdirSync(reqDir, { recursive: true });
      createWikiPage(
        wikiDir,
        "requirements",
        "rate-limiting.md",
        "---\ntype: requirement\nstatus: draft\npriority: p1\nsource_id: SRC-2026-05-16-001\ndepends_on: [requirements/sso-login]\ncreated: 2026-05-16\nupdated: 2026-05-16\n---\n\n# Rate Limiting\n\n## Description\nOAuth endpoints are rate-limited to prevent abuse.\n\n## Dependencies\n- [[requirements/sso-login]] — must be implemented first\n",
      );
      const content = readFile(
        join(wikiDir, ".llm-wiki", "wiki", "requirements", "rate-limiting.md"),
      );
      expect(content).toContain("depends_on: [requirements/sso-login]");
      expect(content).toContain("[[requirements/sso-login]]");
    });

    it("should support all requirement status values", () => {
      const statuses = ["draft", "clarified", "active", "implemented", "deferred", "rejected"];
      const reqDir = join(wikiDir, ".llm-wiki", "wiki", "requirements");
      mkdirSync(reqDir, { recursive: true });
      for (const status of statuses) {
        createWikiPage(
          wikiDir,
          "requirements",
          `req-${status}.md`,
          `---\ntype: requirement\nstatus: ${status}\npriority: p2\ncreated: 2026-05-16\nupdated: 2026-05-16\n---\n\n# ${status}\n`,
        );
        const content = readFile(
          join(wikiDir, ".llm-wiki", "wiki", "requirements", `req-${status}.md`),
        );
        expect(content).toContain(`status: ${status}`);
      }
    });

    it("should be auto-discovered by metadata rebuild", () => {
      const paths = getVaultPaths(wikiDir);
      ensureVaultStructure(paths);

      const reqDir = join(paths.wiki, "requirements");
      mkdirSync(reqDir, { recursive: true });
      writeFileSync(
        join(reqDir, "test-req.md"),
        [
          "---",
          "type: requirement",
          'title: "Test Requirement"',
          "status: draft",
          "priority: p2",
          "created: 2026-05-16",
          "updated: 2026-05-16",
          "---",
          "",
          "# Test Requirement",
          "",
          "A test requirement.",
        ].join("\n"),
        "utf-8",
      );

      const dotWiki = join(paths.dotWiki);
      mkdirSync(dotWiki, { recursive: true });
      writeFileSync(
        join(dotWiki, "config.json"),
        JSON.stringify({ topic: "Test", mode: "personal" }),
        "utf-8",
      );

      rebuildMetadataLight(paths);

      const registry = JSON.parse(readFile(join(paths.meta, "registry.json")));
      const reqPage = Object.entries(registry.pages).find(([id]) => id.startsWith("requirements/"));
      expect(reqPage).toBeDefined();
      if (reqPage) {
        const [, entry] = reqPage as [string, { type: string; title: string }];
        expect(entry.type).toBe("requirement");
        expect(entry.title).toBe('"Test Requirement"');
      }
    });

    it("should be discoverable by wiki_recall after metadata rebuild", async () => {
      const paths = getVaultPaths(wikiDir);
      ensureVaultStructure(paths);

      const reqDir = join(paths.wiki, "requirements");
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

      const dotWiki = join(paths.dotWiki);
      mkdirSync(dotWiki, { recursive: true });
      writeFileSync(
        join(dotWiki, "config.json"),
        JSON.stringify({ topic: "Test", mode: "personal" }),
        "utf-8",
      );

      rebuildMetadataLight(paths);

      const { searchWiki } = await import("../extensions/llm-wiki/lib/recall.js");
      const results = searchWiki(paths, "SSO Login");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id.startsWith("requirements/"))).toBe(true);
    });
  });

  it("should maintain INDEX.md catalog", () => {
    createWikiPage(
      wikiDir,
      "",
      "INDEX.md",
      "# Wiki Index\n\n## Entities\n- [test](entities/test.md)\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "INDEX.md"));
    expect(content).toContain("test");
  });

  it("should append to LOG.md", () => {
    writeFileSync(
      join(wikiDir, ".llm-wiki", "wiki", "LOG.md"),
      "## [2026-04-27] ingest | 3 pages\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "LOG.md"));
    expect(content).toContain("ingest");
    expect(content).toContain("3 pages");
  });

  it("should handle contradiction markers", () => {
    createWikiPage(
      wikiDir,
      "concepts",
      "conflict.md",
      "---\ntype: concept\ndomain: ai\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: [a.md, b.md]\n---\n\n> ⚠️ **Contradiction:** A claims X but B claims Y.\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "concepts", "conflict.md"));
    expect(content).toContain("Contradiction:");
  });
});
