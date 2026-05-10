import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureFile, captureText, captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

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
      expect(content).toContain("argument-hint:");
      expect(content).toContain("section: LLM Wiki");
      expect(content).toContain("topLevelCli: true");
      expect(content).not.toContain("\nargs:");
    }
  });

  it("should include prompt arguments in templates that accept them", () => {
    const promptsWithArgs = [
      "wiki-init.md",
      "wiki-ingest.md",
      "wiki-query.md",
      "wiki-lint.md",
      "wiki-discover.md",
      "wiki-run.md",
      "wiki-digest.md",
    ];
    for (const prompt of promptsWithArgs) {
      const content = readFile(join(rootDir, "prompts", prompt));
      expect(content).toContain("$ARGUMENTS");
    }

    const query = readFile(join(rootDir, "prompts", "wiki-query.md"));
    expect(query).toContain("## User Question");
    expect(query).toContain("$ARGUMENTS");
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
    const sourceExtractorsPath = join(
      rootDir,
      "extensions",
      "llm-wiki",
      "lib",
      "source-extractors.ts",
    );
    expect(existsSync(sourcePacketPath)).toBe(true);
    expect(existsSync(sourceExtractorsPath)).toBe(true);

    const sourcePacket = readFile(sourcePacketPath);
    const sourceExtractors = readFile(sourceExtractorsPath);
    expect(sourcePacket).toContain("captureSource");
    expect(sourcePacket).toContain("fileExtractorFor");
    expect(sourcePacket).toContain("extractUrlContent");
    expect(sourceExtractors).toContain("WIKI_MARKITDOWN_TIMEOUT_MS");
    expect(sourceExtractors).toContain("DEFAULT_MARKITDOWN_TIMEOUT_MS = 180_000");
    expect(sourceExtractors).toContain("URL_EXTRACTORS");
    expect(sourceExtractors).toContain("matches: isPdfUrl");
    expect(sourceExtractors).toContain("looksLikePdf(curlExtracted)");
    expect(sourceExtractors).toContain("pdfExtractionFailureMessage");
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

describe("source packet capture", () => {
  const html = "<html><head><title>Example Page</title></head><body>Hello</body></html>";
  const pdfBytes = "%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\nendobj\n";

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-llm-wiki-capture-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Build a mock pi.exec that optionally handles curl -o file writes. */
  function mockPi(stdout?: string, writeOriginal = true) {
    return {
      exec: async (command: string, args: string[]) => {
        if (command === "sh") return { stdout: "no\n", stderr: "", code: 0 };
        if (command === "curl" && args.includes("-o")) {
          if (writeOriginal) {
            const outputPath = args[args.indexOf("-o") + 1];
            writeFileSync(outputPath, stdout ?? html, "utf-8");
          }
          return { stdout: "", stderr: "", code: 0 };
        }
        if (command === "curl") return { stdout: stdout ?? html, stderr: "", code: 0 };
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }

  function makePaths() {
    const p = getVaultPaths(join(tempDir, `wiki-${Math.random().toString(36).slice(2)}`));
    ensureVaultStructure(p);
    return p;
  }

  it("should preserve the original artifact for URL captures and render clickable links", async () => {
    const paths = makePaths();
    const pi = mockPi();

    const url = "https://example.com/article";
    const result = await captureUrl(pi as never, paths, url);

    // Original artifact preserved
    expect(existsSync(join(result.packetPath, "original", "source.html"))).toBe(true);
    expect(readFile(join(result.packetPath, "original", "source.html"))).toBe(html);
    expect(readFile(join(result.packetPath, "extracted.md"))).toBe(html);

    // Clickable URL in source page
    const sourcePage = readFile(result.sourcePagePath);
    expect(sourcePage).toContain(`> _Original: [${url}](${url})_`);
  });

  it("should write PDF extraction failure message for .pdf URLs when MarkItDown is unavailable", async () => {
    const paths = makePaths();
    const pi = mockPi();

    const url = "https://example.com/report.pdf";
    const result = await captureUrl(pi as never, paths, url);

    // Should NOT have written raw original for .pdf (no uvx)
    expect(existsSync(join(result.packetPath, "original", "source.pdf"))).toBe(true);

    // extracted.md should contain a failure message, not raw bytes
    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).not.toContain("%PDF-");
    expect(extracted).toContain("PDF content could not be converted");
    expect(extracted).toContain(url);
  });

  it("should sniff %PDF- bytes from non-.pdf URLs and write a failure message instead", async () => {
    const paths = makePaths();
    // curl returns PDF bytes from a non-.pdf URL
    const pi = mockPi(pdfBytes);

    const url = "https://example.com/download?format=pdf";
    const result = await captureUrl(pi as never, paths, url);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).not.toContain("%PDF-");
    expect(extracted).toContain("PDF content could not be converted");
    expect(extracted).toContain(url);
  });

  it("should name original artifacts based on URL extension", async () => {
    const cases: Array<{ url: string; expected: string }> = [
      { url: "https://example.com/article.html", expected: "source.html" },
      { url: "https://example.com/doc.pdf", expected: "source.pdf" },
      { url: "https://example.com/notes.md", expected: "source.md" },
      { url: "https://example.com/data.xml", expected: "source.xml" },
      { url: "https://example.com/readme.txt", expected: "source.txt" },
      { url: "https://example.com/page", expected: "source.html" },
      { url: "https://example.com/page?format=pdf", expected: "source.html" },
    ];

    for (const { url, expected } of cases) {
      const paths = makePaths();
      const pi = mockPi();
      const result = await captureUrl(pi as never, paths, url);
      const originalFile = join(result.packetPath, "original", expected);
      expect(existsSync(originalFile)).toBe(true);
    }
  });

  it("should render source page without an Original: line for text captures", async () => {
    const paths = makePaths();
    const result = captureText(paths, "Some text content", "My Note");

    const sourcePage = readFile(result.sourcePagePath);
    expect(sourcePage).toContain("# My Note");
    expect(sourcePage).not.toContain("Original:");
    expect(sourcePage).toContain("_Auto-preview: Some text content_");
  });

  it("should truncate auto-preview to 500 characters", async () => {
    const paths = makePaths();
    const longText = "A".repeat(1000);
    const result = captureText(paths, longText, "Long Note");

    const sourcePage = readFile(result.sourcePagePath);
    // Preview should be 500 chars + "..."
    expect(sourcePage).toContain(`_Auto-preview: ${"A".repeat(500)}..._`);
  });

  it("should handle local PDF file capture failure message when MarkItDown is unavailable", async () => {
    const paths = makePaths();
    // Create a temporary PDF file
    const pdfPath = join(tempDir, "test.pdf");
    writeFileSync(pdfPath, pdfBytes, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, pdfPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).not.toContain("%PDF-");
    expect(extracted).toContain("PDF content could not be converted");
  });

  it("should copy local non-PDF file content to extracted.md", async () => {
    const paths = makePaths();
    const mdPath = join(tempDir, "notes.md");
    writeFileSync(mdPath, "# My Notes\n\nHello world.", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, mdPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("# My Notes");
    expect(extracted).toContain("Hello world.");

    // Original file should be preserved
    expect(existsSync(join(result.packetPath, "original", "notes.md"))).toBe(true);
  });

  it("should convert XML files to readable markdown in extracted.md", async () => {
    const paths = makePaths();
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<document>
  <title>Project Report</title>
  <section>
    <heading>Findings</heading>
    <p>The analysis revealed several key insights.</p>
    <list>
      <item>First finding</item>
      <item>Second finding</item>
    </list>
  </section>
</document>`;
    const xmlPath = join(tempDir, "report.xml");
    writeFileSync(xmlPath, xmlContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, xmlPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    // Should have extracted title
    expect(extracted).toContain("Project Report");
    // Should have extracted text content
    expect(extracted).toContain("The analysis revealed several key insights.");
    expect(extracted).toContain("First finding");
    expect(extracted).toContain("Second finding");
    // Should NOT contain raw XML tags
    expect(extracted).not.toContain("<?xml");
    expect(extracted).not.toContain("<document>");
    expect(extracted).not.toContain("</document>");

    // Original file should be preserved
    expect(existsSync(join(result.packetPath, "original", "report.xml"))).toBe(true);
  });

  it("should fall back to raw XML content when tag stripping produces nothing", async () => {
    const paths = makePaths();
    const xmlContent = `<?xml version="1.0"?><data><![CDATA[Hello]]></data>`;
    const xmlPath = join(tempDir, "minimal.xml");
    writeFileSync(xmlPath, xmlContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, xmlPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    // Should have the text content at minimum
    expect(extracted).toContain("Hello");
  });

  it("should convert JSON files to readable markdown in extracted.md", async () => {
    const paths = makePaths();
    const jsonContent = JSON.stringify(
      {
        title: "Project Roadmap",
        scope: "Improve the client portal and project record.",
        assumptions: ["Routes already exist", "Use generated API types"],
        tasks: [
          {
            id: "client-portal",
            title: "Client portal hardening",
            acceptance: ["Shows open actions", "Build passes"],
          },
        ],
      },
      null,
      2,
    );
    const jsonPath = join(tempDir, "roadmap.json");
    writeFileSync(jsonPath, jsonContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, jsonPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("# Project Roadmap");
    expect(extracted).toContain("**Scope:** Improve the client portal and project record.");
    expect(extracted).toMatch(/^## Assumptions$/m);
    expect(extracted).not.toMatch(/^### Assumptions$/m);
    expect(extracted).toContain("- Routes already exist");
    expect(extracted).toMatch(/^## Tasks$/m);
    expect(extracted).not.toMatch(/^### Tasks$/m);
    expect(extracted).toMatch(/^### Client portal hardening$/m);
    expect(extracted).toContain("Shows open actions");
    expect(extracted).not.toContain('"tasks"');
    expect(extracted).not.toContain("{");

    expect(existsSync(join(result.packetPath, "original", "roadmap.json"))).toBe(true);

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("json");
  });

  it("should fall back to raw JSON content when parsing fails", async () => {
    const paths = makePaths();
    const jsonContent = `{ "title": "Broken", `;
    const jsonPath = join(tempDir, "broken.json");
    writeFileSync(jsonPath, jsonContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, jsonPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toBe(jsonContent);
  });
});

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
