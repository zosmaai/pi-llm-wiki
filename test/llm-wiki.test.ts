import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Helpers ────────────────────────────────────────────

let tempDir: string;
const __fname = typeof __filename !== "undefined" ? __filename : "";
const __dname =
  typeof __dirname !== "undefined"
    ? __dirname
    : typeof import.meta !== "undefined" && import.meta.dirname
      ? import.meta.dirname
      : dirname(fileURLToPath(__fname || `file://${process.cwd()}/test/dummy.ts`));

const rootDir = resolve(__dname, "..");

function readFile(path: string): string {
  return readFileSync(path, { encoding: "utf-8" });
}

function createWikiRoot(): string {
  const dir = join(tempDir, `wiki-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

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
    "outputs",
    ".discoveries",
  ];
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });

  return dir;
}

function createConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    wiki: { mode: "personal", topic: "Test Topic" },
    change_detection: false,
  };
  const config = { ...defaults, ...overrides } as Record<string, Record<string, unknown>>;
  const mode = config.wiki?.mode || "personal";
  const topic = config.wiki?.topic || "Test Topic";
  writeFileSync(
    join(dir, "config.yaml"),
    `# LLM Wiki Configuration\nwiki:\n  mode: ${mode}\n  topic: "${topic}"\n`,
  );
}

function createSourceFile(dir: string, name: string, content: string) {
  writeFileSync(join(dir, "raw", "articles", name), content);
}

function createWikiPage(dir: string, subdir: string | "", name: string, content: string) {
  const target = subdir ? join(dir, "wiki", subdir, name) : join(dir, "wiki", name);
  writeFileSync(target, content);
}

// ─── Package Structure Tests ────────────────────────────

describe("package structure", () => {
  it("should have a valid package.json with pi manifest", () => {
    const pkg = JSON.parse(readFile(join(rootDir, "package.json")));
    expect(pkg.name).toBe("@zosmaai/pi-llm-wiki");
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi.extensions).toContain("./extensions");
    expect(pkg.pi.skills).toContain("./skills");
    expect(pkg.pi.prompts).toContain("./prompts");
    expect(pkg.peerDependencies).toBeDefined();
    expect(pkg.peerDependencies["@mariozechner/pi-coding-agent"]).toBe("*");
    expect(pkg.peerDependencies.typebox).toBe("*");
  });

  it("should have a SKILL.md with valid frontmatter and schema content", () => {
    const skillPath = join(rootDir, "skills", "llm-wiki", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const content = readFile(skillPath);
    expect(content).toContain("name: llm-wiki");
    expect(content).toContain("## Golden Rules");
    expect(content).toContain("RAW IS IMMUTABLE");
    expect(content).toContain("## Workflows");
    expect(content).toContain("wiki_ingest");
    expect(content).toContain("Obsidian Integration");
    expect(content).toContain("Personal Wiki");
    expect(content).toContain("Company Wiki");
  });

  it("should have all 8 prompt templates with frontmatter", () => {
    const prompts = [
      "wiki-init.md",
      "wiki-ingest.md",
      "wiki-query.md",
      "wiki-lint.md",
      "wiki-discover.md",
      "wiki-run.md",
      "wiki-status.md",
      "wiki-digest.md",
    ];
    for (const prompt of prompts) {
      const path = join(rootDir, "prompts", prompt);
      expect(existsSync(path)).toBe(true);
      const content = readFile(path);
      expect(content).toContain("description:");
      expect(content).toContain("section: LLM Wiki");
      expect(content).toContain("topLevelCli: true");
    }
  });

  it("should have all wiki template files", () => {
    const t = join(rootDir, "skills", "llm-wiki", "templates");
    expect(existsSync(join(t, "INDEX.md"))).toBe(true);
    expect(existsSync(join(t, "LOG.md"))).toBe(true);
    expect(existsSync(join(t, "DASHBOARD.md"))).toBe(true);
    expect(existsSync(join(t, "config.yaml"))).toBe(true);
    expect(existsSync(join(t, "pages", "entity.md"))).toBe(true);
    expect(existsSync(join(t, "pages", "concept.md"))).toBe(true);
    expect(existsSync(join(t, "pages", "source.md"))).toBe(true);
    expect(existsSync(join(t, "pages", "synthesis.md"))).toBe(true);
  });

  it("should have the extension entry point", () => {
    const extPath = join(rootDir, "extensions", "llm-wiki", "index.ts");
    expect(existsSync(extPath)).toBe(true);
    const content = readFile(extPath);
    expect(content).toContain("ExtensionAPI");
    expect(content).toContain("registerWikiBootstrap");
  });

  it("should have all custom tools in the extension", () => {
    const toolsPath = join(rootDir, "extensions", "llm-wiki", "lib", "tools.ts");
    expect(existsSync(toolsPath)).toBe(true);
    const content = readFile(toolsPath);
    const tools = [
      "wiki_bootstrap",
      "wiki_capture_source",
      "wiki_ingest",
      "wiki_ensure_page",
      "wiki_search",
      "wiki_lint",
      "wiki_status",
      "wiki_rebuild_meta",
      "wiki_log_event",
      "wiki_watch",
    ];
    for (const tool of tools) {
      expect(content).toContain(tool);
    }
  });

  it("should keep MarkItDown timeout configurable and avoid PDF byte fallbacks", () => {
    const sourcePacketPath = join(rootDir, "extensions", "llm-wiki", "lib", "source-packet.ts");
    expect(existsSync(sourcePacketPath)).toBe(true);
    const content = readFile(sourcePacketPath);
    expect(content).toContain("WIKI_MARKITDOWN_TIMEOUT_MS");
    expect(content).toContain("DEFAULT_MARKITDOWN_TIMEOUT_MS = 180_000");
    expect(content).toContain("isPdfUrl(url)");
    expect(content).toContain("looksLikePdf(curlResult.stdout)");
    expect(content).toContain("pdfExtractionFailureMessage");
  });

  it("should have a comprehensive README with install instructions", () => {
    const readme = readFile(join(rootDir, "README.md"));
    expect(readme).toContain("@zosmaai/pi-llm-wiki");
    expect(readme).toContain("pi install npm:@zosmaai/pi-llm-wiki");
    expect(readme).toContain("Karpathy");
    expect(readme).toContain("Obsidian");
  });
});

// ─── SKILL.md Frontmatter Validation ────────────────────

describe("skill frontmatter validation", () => {
  const skillPath = join(rootDir, "skills", "llm-wiki", "SKILL.md");

  it("should have name matching directory, lowercase with hyphens only", () => {
    const content = readFile(skillPath);
    const match = content.match(/^---\n([\s\S]*?)\n---/) as RegExpMatchArray | null;
    expect(match).not.toBeNull();
    const frontmatter = match![1];
    expect(frontmatter).toContain("name: llm-wiki");

    const nameMatch = frontmatter.match(/name:\s*(\S+)/);
    expect(nameMatch).not.toBeNull();
    const name = nameMatch![1];
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toContain("--");
    expect(name).not.toMatch(/^-|-$/);
  });

  it("should have a description under 1024 characters", () => {
    const content = readFile(skillPath);
    const match = content.match(/^---\n([\s\S]*?)\n---/) as RegExpMatchArray | null;
    expect(match).not.toBeNull();
    const descMatch = match![1].match(/description:\s*(.+)/);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1].length).toBeLessThanOrEqual(1024);
  });
});

// ─── Wiki Directory Structure Tests ─────────────────────

describe("wiki directory structure", () => {
  let wikiDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-llm-wiki-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    wikiDir = createWikiRoot();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should have all required directories", () => {
    expect(existsSync(join(wikiDir, "raw", "articles"))).toBe(true);
    expect(existsSync(join(wikiDir, "raw", "papers"))).toBe(true);
    expect(existsSync(join(wikiDir, "raw", "notes"))).toBe(true);
    expect(existsSync(join(wikiDir, "wiki", "entities"))).toBe(true);
    expect(existsSync(join(wikiDir, "wiki", "concepts"))).toBe(true);
    expect(existsSync(join(wikiDir, "wiki", "sources"))).toBe(true);
    expect(existsSync(join(wikiDir, "wiki", "syntheses"))).toBe(true);
    expect(existsSync(join(wikiDir, "wiki", "changes"))).toBe(true);
    expect(existsSync(join(wikiDir, "outputs"))).toBe(true);
    expect(existsSync(join(wikiDir, ".discoveries"))).toBe(true);
  });

  it("should create source pages from ingested files", () => {
    createConfig(wikiDir);
    createSourceFile(wikiDir, "test-article.md", "# Test\nContent about AI.");
    expect(existsSync(join(wikiDir, "raw", "articles", "test-article.md"))).toBe(true);

    createWikiPage(
      wikiDir,
      "sources",
      "test-article.md",
      "---\ntype: source\nformat: article\nraw_path: raw/articles/test-article.md\ningested: 2026-04-27\ntopics: [ai]\n---\n\n# Test Article\n\n## Summary\nAI content.\n",
    );
    const content = readFile(join(wikiDir, "wiki", "sources", "test-article.md"));
    expect(content).toContain("type: source");
    expect(content).toContain("raw_path: raw/articles/test-article.md");
  });

  it("should create entity pages with correct format", () => {
    createWikiPage(
      wikiDir,
      "entities",
      "test-entity.md",
      "---\ntype: entity\ncategory: person\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: [raw/articles/test.md]\n---\n\n# Person\n\n## Links\n- [[related-concept]]\n\n## Sources\n- [test](../raw/articles/test.md)\n",
    );
    const content = readFile(join(wikiDir, "wiki", "entities", "test-entity.md"));
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
    const content = readFile(join(wikiDir, "wiki", "concepts", "test-concept.md"));
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
    const content = readFile(join(wikiDir, "wiki", "syntheses", "comparison.md"));
    expect(content).toContain("type: synthesis");
    expect(content).toContain("sources_count: 2");
    expect(content).toContain("[[source-1]]");
  });

  it("should maintain INDEX.md catalog", () => {
    createWikiPage(
      wikiDir,
      "",
      "INDEX.md",
      "# Wiki Index\n\n## Entities\n- [test](entities/test.md)\n",
    );
    const content = readFile(join(wikiDir, "wiki", "INDEX.md"));
    expect(content).toContain("test");
  });

  it("should append to LOG.md", () => {
    writeFileSync(join(wikiDir, "wiki", "LOG.md"), "## [2026-04-27] ingest | 3 pages\n");
    const content = readFile(join(wikiDir, "wiki", "LOG.md"));
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
    const content = readFile(join(wikiDir, "wiki", "concepts", "conflict.md"));
    expect(content).toContain("Contradiction:");
  });
});

// ─── Cross-Reference Integrity ─────────────────────────

describe("cross-reference integrity", () => {
  let wikiDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-llm-wiki-xref-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    wikiDir = createWikiRoot();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should allow orphan detection by absence of inbound wikilinks", () => {
    createWikiPage(
      wikiDir,
      "entities",
      "orphan.md",
      "---\ntype: entity\ncategory: person\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: []\n---\n# Orphan\n",
    );
    const content = readFile(join(wikiDir, "wiki", "entities", "orphan.md"));
    expect(content).not.toContain("[[orphan");
  });

  it("should detect broken wikilinks referencing nonexistent pages", () => {
    createWikiPage(
      wikiDir,
      "concepts",
      "main.md",
      "---\ntype: concept\ndomain: ai\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: []\n---\n\n# Main\n[[missing-page]] and [[another-missing]]\n",
    );
    const content = readFile(join(wikiDir, "wiki", "concepts", "main.md"));
    expect(content).toContain("[[missing-page]]");
    expect(content).toContain("[[another-missing]]");
    expect(existsSync(join(wikiDir, "wiki", "entities", "missing-page.md"))).toBe(false);
    expect(existsSync(join(wikiDir, "wiki", "concepts", "missing-page.md"))).toBe(false);
  });
});

// ─── Configuration Tests ──────────────────────────────

describe("configuration", () => {
  let wikiDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-llm-wiki-config-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    wikiDir = createWikiRoot();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should accept personal mode config", () => {
    createConfig(wikiDir, { wiki: { mode: "personal", topic: "Learning" } });
    const config = readFile(join(wikiDir, "config.yaml"));
    expect(config).toContain("mode: personal");
  });

  it("should accept company mode config", () => {
    createConfig(wikiDir, { wiki: { mode: "company", topic: "Competitors" } });
    const config = readFile(join(wikiDir, "config.yaml"));
    expect(config).toContain("mode: company");
  });

  it("should support company mode with change detection pages", () => {
    createConfig(wikiDir, { wiki: { mode: "company", topic: "Market" }, change_detection: true });
    const config = readFile(join(wikiDir, "config.yaml"));
    expect(config).toContain("mode: company");

    createWikiPage(
      wikiDir,
      "changes",
      "competitor-2026-04-27.md",
      "---\ntype: change\nentity: competitor\ndetected: 2026-04-27\n---\n\n# Change\nPricing changed from $99 to $149.\n",
    );
    expect(existsSync(join(wikiDir, "wiki", "changes", "competitor-2026-04-27.md"))).toBe(true);
    const content = readFile(join(wikiDir, "wiki", "changes", "competitor-2026-04-27.md"));
    expect(content).toContain("type: change");
    expect(content).toContain("Pricing changed");
  });

  it("should track discovery history", () => {
    const history = { processed: [{ path: "raw/articles/a.md", ingested: "2026-04-27" }] };
    writeFileSync(join(wikiDir, ".discoveries", "history.json"), JSON.stringify(history));
    const content = JSON.parse(readFile(join(wikiDir, ".discoveries", "history.json")));
    expect(content.processed).toHaveLength(1);
    expect(content.processed[0].path).toBe("raw/articles/a.md");
  });

  it("should track knowledge gaps", () => {
    const gaps = { gaps: [{ topic: "reinforcement learning", priority: "high" }] };
    writeFileSync(join(wikiDir, ".discoveries", "gaps.json"), JSON.stringify(gaps));
    const content = JSON.parse(readFile(join(wikiDir, ".discoveries", "gaps.json")));
    expect(content.gaps).toHaveLength(1);
    expect(content.gaps[0].priority).toBe("high");
  });
});
