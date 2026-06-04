import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureFile, captureText, captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { mockPi, mockPiWithMarkItDown, readFile } from "./helpers.js";

describe("source packet capture", () => {
  const html = "<html><head><title>Example Page</title></head><body>Hello</body></html>";
  const pdfBytes = "%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\nendobj\n";
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `source-capture-${Date.now()}`);
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

  it("should preserve the original artifact for URL captures and render clickable links", async () => {
    const paths = makePaths();
    const pi = mockPi();

    const url = "https://example.com/article";
    const result = await captureUrl(pi as never, paths, url);

    expect(existsSync(join(result.packetPath, "original", "source.html"))).toBe(true);
    // original artifact is preserved as-is
    expect(readFile(join(result.packetPath, "original", "source.html"))).toBe(html);
    // extracted.md is normalized markdown, not raw HTML
    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("Example Page");
    expect(extracted).toContain("Hello");
    expect(extracted).not.toContain("<html>");
    expect(extracted).not.toContain("<body>");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.extractor).toBe("htmlToMarkdown");

    const sourcePage = readFile(result.sourcePagePath);
    expect(sourcePage).toContain(`> _Original: [${url}](${url})_`);
  });

  it("should write PDF extraction failure message for .pdf URLs when MarkItDown is unavailable", async () => {
    const paths = makePaths();
    const pi = mockPi();

    const url = "https://example.com/report.pdf";
    const result = await captureUrl(pi as never, paths, url);

    expect(existsSync(join(result.packetPath, "original", "source.pdf"))).toBe(true);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).not.toContain("%PDF-");
    expect(extracted).toContain("PDF content could not be converted");
    expect(extracted).toContain(url);
  });

  it("should sniff %PDF- bytes from non-.pdf URLs and write a failure message instead", async () => {
    const paths = makePaths();
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
    expect(sourcePage).toContain(`_Auto-preview: ${"A".repeat(500)}..._`);
  });

  it("should handle local PDF file capture failure message when MarkItDown is unavailable", async () => {
    const paths = makePaths();
    const pdfPath = join(tmpDir, "test.pdf");
    writeFileSync(pdfPath, pdfBytes, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, pdfPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).not.toContain("%PDF-");
    expect(extracted).toContain("PDF content could not be converted");
  });

  it("should copy local non-PDF file content to extracted.md", async () => {
    const paths = makePaths();
    const mdPath = join(tmpDir, "notes.md");
    writeFileSync(mdPath, "# My Notes\n\nHello world.", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, mdPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("# My Notes");
    expect(extracted).toContain("Hello world.");

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
    const xmlPath = join(tmpDir, "report.xml");
    writeFileSync(xmlPath, xmlContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, xmlPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("Project Report");
    expect(extracted).toContain("The analysis revealed several key insights.");
    expect(extracted).toContain("First finding");
    expect(extracted).toContain("Second finding");
    expect(extracted).not.toContain("<?xml");
    expect(extracted).not.toContain("<document>");
    expect(extracted).not.toContain("</document>");

    expect(existsSync(join(result.packetPath, "original", "report.xml"))).toBe(true);
  });

  it("should fall back to raw XML content when tag stripping produces nothing", async () => {
    const paths = makePaths();
    const xmlContent = `<?xml version="1.0"?><data><![CDATA[Hello]]></data>`;
    const xmlPath = join(tmpDir, "minimal.xml");
    writeFileSync(xmlPath, xmlContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, xmlPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
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
    const jsonPath = join(tmpDir, "roadmap.json");
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
    const jsonPath = join(tmpDir, "broken.json");
    writeFileSync(jsonPath, jsonContent, "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, jsonPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toBe(jsonContent);
  });

  it("should write a failure message for .docx files when MarkItDown is unavailable", async () => {
    const paths = makePaths();
    const docxPath = join(tmpDir, "report.docx");
    writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, docxPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).not.toContain("PK");
    expect(extracted).toContain("DOCX content could not be converted");
    expect(extracted).toContain("report.docx");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("docx");
    expect(manifest.extraction_status).toBe("failed");
    expect(manifest.extractor).toBe("markitdown");
  });

  it("should convert .docx content to markdown via MarkItDown when available", async () => {
    const paths = makePaths();
    const docxPath = join(tmpDir, "proposal.docx");
    writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const pi = mockPiWithMarkItDown("# Proposal\n\nThis is the extracted content.");
    const result = await captureFile(pi as never, paths, docxPath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("# Proposal");
    expect(extracted).toContain("extracted content");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("docx");
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.extractor).toBe("markitdown");
  });

  it("should record extractor and extraction_status in manifest for XML captures", async () => {
    const paths = makePaths();
    const xmlPath = join(tmpDir, "data.xml");
    writeFileSync(xmlPath, "<root><title>Test</title><body>Content here.</body></root>", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, xmlPath);

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.extractor).toBe("xmlToMarkdown");
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.content_type).toBe("application/xml");
  });

  it("should record extractor and extraction_status in manifest for JSON captures", async () => {
    const paths = makePaths();
    const jsonPath = join(tmpDir, "data.json");
    writeFileSync(jsonPath, JSON.stringify({ title: "Test", value: 42 }), "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, jsonPath);

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.extractor).toBe("jsonToMarkdown");
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.content_type).toBe("application/json");
  });
});
