/**
 * E2E tests for HTML normalization on the curl fallback path (Issue #55).
 *
 * All tests go through captureUrl with mockPi(html) — same pipeline pi uses
 * when MarkItDown is unavailable and curl fetches the page.
 *
 * Also tests htmlToMarkdown directly for unit-level coverage of each rule.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../extensions/llm-wiki/lib/source-extractors.js";
import { captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { mockPi, mockPiWithMarkItDown, readFile } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(body: string, title = "Test Page") {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

describe("HTML normalization (issue #55)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `html-norm-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function makePaths() {
    const p = getVaultPaths(join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`));
    ensureVaultStructure(p);
    return p;
  }

  // ── Unit tests for htmlToMarkdown ────────────────────────────────────────

  describe("htmlToMarkdown unit", () => {
    it("extracts <title> as # heading", () => {
      const out = htmlToMarkdown(wrap("<p>Content</p>", "My Article"));
      expect(out).toMatch(/^# My Article/);
    });

    it("removes <head> block entirely", () => {
      const out = htmlToMarkdown(
        `<html><head><title>T</title><meta charset="utf-8"><link rel="stylesheet" href="/s.css"></head><body>Body</body></html>`,
      );
      expect(out).not.toContain("<meta");
      expect(out).not.toContain("<link");
      expect(out).not.toContain("stylesheet");
    });

    it("strips <script> blocks and their content entirely", () => {
      const out = htmlToMarkdown(
        wrap('<script>alert("xss"); var secret = 42;</script><p>Real content</p>'),
      );
      expect(out).not.toContain("alert");
      expect(out).not.toContain("secret");
      expect(out).not.toContain("<script>");
      expect(out).toContain("Real content");
    });

    it("strips <style> blocks and their content entirely", () => {
      const out = htmlToMarkdown(wrap("<style>.nav { display:none }</style><p>Text</p>"));
      expect(out).not.toContain(".nav");
      expect(out).not.toContain("display:none");
      expect(out).toContain("Text");
    });

    it("strips <nav> block and its content entirely", () => {
      const out = htmlToMarkdown(
        wrap("<nav><a href='/home'>Home</a><a href='/about'>About</a></nav><p>Article</p>"),
      );
      expect(out).not.toContain("Home");
      expect(out).not.toContain("About");
      expect(out).toContain("Article");
    });

    it("strips <header> block and its content entirely", () => {
      const out = htmlToMarkdown(wrap("<header><h1>Site Name</h1></header><p>Article</p>"));
      // header block removed — "Site Name" should not appear
      expect(out).not.toContain("Site Name");
      expect(out).toContain("Article");
    });

    it("strips <footer> block and its content entirely", () => {
      const out = htmlToMarkdown(wrap("<p>Content</p><footer>Copyright 2025</footer>"));
      expect(out).not.toContain("Copyright 2025");
      expect(out).toContain("Content");
    });

    it("strips <noscript> block and its content entirely", () => {
      const out = htmlToMarkdown(wrap("<noscript>Enable JavaScript</noscript><p>Content</p>"));
      expect(out).not.toContain("Enable JavaScript");
      expect(out).toContain("Content");
    });

    it("converts <h1>–<h6> to markdown # headings preserving level", () => {
      const out = htmlToMarkdown(
        wrap("<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>"),
      );
      expect(out).toContain("# One");
      expect(out).toContain("## Two");
      expect(out).toContain("### Three");
      expect(out).toContain("#### Four");
      expect(out).toContain("##### Five");
      expect(out).toContain("###### Six");
    });

    it("strips inner tags from heading content", () => {
      const out = htmlToMarkdown(wrap("<h2><strong>Bold</strong> heading</h2>"));
      // node-html-markdown preserves inline formatting inside headings
      expect(out).toContain("## ");
      expect(out).toContain("Bold");
      expect(out).toContain("heading");
      expect(out).not.toContain("<strong>");
      expect(out).not.toContain("<h2>");
    });

    it("converts <a href> to [text](url)", () => {
      const out = htmlToMarkdown(
        wrap('<p>Read the <a href="https://example.com/docs">documentation</a> here.</p>'),
      );
      expect(out).toContain("[documentation](https://example.com/docs)");
      expect(out).not.toContain("<a ");
    });

    it("converts <a href> with single-quoted attribute", () => {
      const out = htmlToMarkdown(wrap("<p>Visit <a href='https://example.com'>Example</a>.</p>"));
      expect(out).toContain("[Example](https://example.com)");
    });

    it("converts <li> items to markdown bullets", () => {
      const out = htmlToMarkdown(
        wrap("<ul><li>First item</li><li>Second item</li><li>Third item</li></ul>"),
      );
      // node-html-markdown uses * for unordered lists
      expect(out).toContain("First item");
      expect(out).toContain("Second item");
      expect(out).toContain("Third item");
      expect(out).toMatch(/[*-] First item/);
      expect(out).not.toContain("<li>");
    });

    it("converts <blockquote> to > prefix", () => {
      const out = htmlToMarkdown(wrap("<blockquote>Famous quote here</blockquote>"));
      expect(out).toContain("> Famous quote here");
      expect(out).not.toContain("<blockquote>");
    });

    it("decodes &amp; entity", () => {
      const out = htmlToMarkdown(wrap("<p>Cats &amp; Dogs</p>"));
      expect(out).toContain("Cats & Dogs");
      expect(out).not.toContain("&amp;");
    });

    it("decodes &lt; and &gt; entities", () => {
      const out = htmlToMarkdown(wrap("<p>x &lt; y &gt; z</p>"));
      expect(out).toContain("x < y > z");
    });

    it("decodes &quot; entity", () => {
      const out = htmlToMarkdown(wrap("<p>She said &quot;hello&quot;</p>"));
      expect(out).toContain('She said "hello"');
    });

    it("decodes &apos; entity", () => {
      const out = htmlToMarkdown(wrap("<p>It&apos;s fine</p>"));
      expect(out).toContain("It's fine");
    });

    it("decodes numeric HTML entities", () => {
      const out = htmlToMarkdown(wrap("<p>&#169; 2025</p>"));
      // &#169; is the copyright symbol ©
      expect(out).toContain("© 2025");
    });

    it("collapses 3+ consecutive newlines to 2", () => {
      const out = htmlToMarkdown(wrap("<div>A</div><div>B</div><div>C</div><div>D</div>"));
      expect(out).not.toMatch(/\n{3,}/);
    });

    it("produces no raw HTML tags in output for a full page", () => {
      const page = `<!DOCTYPE html>
<html>
<head>
  <title>Full Page</title>
  <style>body { font-size: 16px }</style>
</head>
<body>
  <nav><a href="/">Home</a></nav>
  <header><h1>Site Title</h1></header>
  <main>
    <h2>Article Title</h2>
    <p>First paragraph with a <a href="https://example.com">link</a>.</p>
    <ul><li>Item one</li><li>Item two</li></ul>
  </main>
  <footer>Footer content</footer>
  <script>console.log("hi")</script>
</body>
</html>`;
      const out = htmlToMarkdown(page);
      expect(out).not.toMatch(/<[a-z]/i);
      expect(out).toContain("## Article Title");
      expect(out).toContain("First paragraph");
      expect(out).toContain("[link](https://example.com)");
      expect(out).toMatch(/[*-] Item one/);
      expect(out).not.toContain("console.log");
      expect(out).not.toContain("font-size");
      expect(out).not.toContain("Footer content");
    });

    it("falls back to original HTML if result would be empty", () => {
      const garbage = "<html><head></head><body></body></html>";
      const out = htmlToMarkdown(garbage);
      // stripping produces empty string → return original
      expect(out).toBe(garbage);
    });
  });

  // ── Improvements over custom implementation ──────────────────────────────

  describe("node-html-markdown improvements", () => {
    it("preserves <strong> as **bold**", () => {
      const out = htmlToMarkdown(wrap("<p>Use <strong>self-attention</strong> layers.</p>"));
      expect(out).toContain("**self-attention**");
    });

    it("preserves <em> as _italic_", () => {
      const out = htmlToMarkdown(wrap("<p>Process <em>in parallel</em>.</p>"));
      expect(out).toMatch(/_in parallel_|\*in parallel\*/);
    });

    it("preserves <ol><li> as numbered list", () => {
      const out = htmlToMarkdown(
        wrap("<ol><li>First step</li><li>Second step</li><li>Third step</li></ol>"),
      );
      expect(out).toContain("1. First step");
      expect(out).toContain("2. Second step");
      expect(out).toContain("3. Third step");
    });

    it("preserves inline <code> as backtick", () => {
      const out = htmlToMarkdown(wrap("<p>Run <code>npm install</code> first.</p>"));
      expect(out).toContain("`npm install`");
    });

    it("preserves <pre><code> as fenced code block", () => {
      const out = htmlToMarkdown(wrap("<pre><code>const x = 1;\nconst y = 2;</code></pre>"));
      expect(out).toContain("```");
      expect(out).toContain("const x = 1;");
    });

    it("preserves <table> as GFM markdown table", () => {
      const out = htmlToMarkdown(
        wrap(
          "<table><tr><th>Model</th><th>Params</th></tr>" +
            "<tr><td>BERT</td><td>110M</td></tr></table>",
        ),
      );
      expect(out).toContain("Model");
      expect(out).toContain("Params");
      expect(out).toContain("BERT");
      expect(out).toContain("110M");
      // Values should NOT be merged on one line (old custom impl bug)
      expect(out).not.toMatch(/BERT.*110M.*BERT|Model.*Params.*Model/);
    });

    it("preserves <img> alt text as ![alt](src)", () => {
      const out = htmlToMarkdown(wrap('<img src="/diagram.png" alt="Architecture diagram">'));
      expect(out).toContain("Architecture diagram");
      expect(out).toContain("/diagram.png");
    });
  });

  // ── Integration tests via captureUrl ─────────────────────────────────────

  describe("captureUrl curl fallback integration", () => {
    it("extracted.md contains normalized markdown, not raw HTML tags", async () => {
      const html = wrap("<h2>Main Heading</h2><p>Some article content.</p>", "Article Title");
      const paths = makePaths();
      const result = await captureUrl(mockPi(html) as never, paths, "https://example.com/article");

      const extracted = readFile(join(result.packetPath, "extracted.md"));
      expect(extracted).not.toMatch(/<[a-z]/i);
      expect(extracted).toContain("Article Title");
      expect(extracted).toContain("## Main Heading");
      expect(extracted).toContain("Some article content.");
    });

    it("manifest extractor is htmlToMarkdown on curl path", async () => {
      const paths = makePaths();
      const result = await captureUrl(
        mockPi(wrap("<p>Content</p>")) as never,
        paths,
        "https://example.com",
      );
      const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
      expect(manifest.extractor).toBe("htmlToMarkdown");
      expect(manifest.extraction_status).toBe("success");
    });

    it("original artifact is preserved as raw HTML, extracted.md is clean", async () => {
      const html = wrap("<p>Clean content</p>", "My Page");
      const paths = makePaths();
      const result = await captureUrl(mockPi(html) as never, paths, "https://example.com/page");

      // original untouched
      expect(readFile(join(result.packetPath, "original", "source.html"))).toBe(html);
      // extracted clean
      const extracted = readFile(join(result.packetPath, "extracted.md"));
      expect(extracted).not.toContain("<p>");
      expect(extracted).toContain("Clean content");
    });

    it("script and style content does not appear in extracted.md", async () => {
      const html = wrap(
        `<script>var password = "secret123"</script>
         <style>.hidden { display:none }</style>
         <p>Visible content</p>`,
        "Page",
      );
      const paths = makePaths();
      const result = await captureUrl(mockPi(html) as never, paths, "https://example.com");

      const extracted = readFile(join(result.packetPath, "extracted.md"));
      expect(extracted).not.toContain("secret123");
      expect(extracted).not.toContain("display:none");
      expect(extracted).toContain("Visible content");
    });

    it("MarkItDown path is completely unchanged — extractor stays markitdown", async () => {
      const markdownContent = "# From MarkItDown\n\nExtracted via markitdown tool.";
      const paths = makePaths();
      const result = await captureUrl(
        mockPiWithMarkItDown(markdownContent) as never,
        paths,
        "https://example.com",
      );

      const extracted = readFile(join(result.packetPath, "extracted.md"));
      expect(extracted).toContain("# From MarkItDown");

      const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
      expect(manifest.extractor).toBe("markitdown");
      // Must NOT be htmlToMarkdown
      expect(manifest.extractor).not.toBe("htmlToMarkdown");
    });

    it("page title extracted from <title> tag appears as # heading in extracted.md", async () => {
      const html = wrap("<p>Body text</p>", "Extracted Title");
      const paths = makePaths();
      const result = await captureUrl(mockPi(html) as never, paths, "https://example.com");

      const extracted = readFile(join(result.packetPath, "extracted.md"));
      expect(extracted).toMatch(/^# Extracted Title/);
    });
  });
});
