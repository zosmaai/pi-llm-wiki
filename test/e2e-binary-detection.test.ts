/**
 * E2E tests for magic bytes binary detection (Issue #56).
 *
 * Covers:
 *   - Each of the 7 binary signatures bails out with a clear failure message
 *     and sets extraction_status: "unsupported" in the manifest
 *   - Plain text files with no extension are still captured correctly
 *   - Plain text files with an unrecognised extension are still captured correctly
 *   - Named extractors (.md, .pdf, .docx, .json, .xml) are NOT intercepted by the guard
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureFile } from "../extensions/llm-wiki/lib/source-packet.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { mockPi, readFile } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMagicBytes(hex: number[]): Buffer {
  // Pad to 64 bytes so the file is clearly "binary" in practice
  const buf = Buffer.alloc(64, 0x00);
  for (const [i, b] of hex.entries()) buf[i] = b;
  return buf;
}

const SIGNATURES = [
  // Archives & documents
  { label: "ZIP (PK header)", format: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: "PDF (%PDF)", format: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { label: "7-Zip", format: "7z", bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { label: "gzip", format: "gzip", bytes: [0x1f, 0x8b] },
  // Images
  { label: "PNG", format: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: "JPEG", format: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { label: "GIF", format: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { label: "BMP", format: "bmp", bytes: [0x42, 0x4d] },
  { label: "TIFF (little-endian)", format: "tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { label: "TIFF (big-endian)", format: "tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { label: "RIFF (WAV/AVI/WebP)", format: "riff", bytes: [0x52, 0x49, 0x46, 0x46] },
  // Executables & binaries
  { label: "Windows EXE/DLL (MZ)", format: "exe", bytes: [0x4d, 0x5a] },
  { label: "Mach-O 64-bit LE", format: "macho", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: "Mach-O 32-bit LE", format: "macho", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { label: "Mach-O 64-bit BE", format: "macho", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { label: "Mach-O 32-bit BE", format: "macho", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { label: "Java .class / Mach-O FAT", format: "class", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: "ELF binary", format: "elf", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: "WebAssembly", format: "wasm", bytes: [0x00, 0x61, 0x73, 0x6d] },
  // Data & media
  { label: "SQLite", format: "sqlite", bytes: [0x53, 0x51, 0x4c, 0x69] },
  { label: "MP3 (ID3)", format: "mp3", bytes: [0x49, 0x44, 0x33] },
] as const;

describe("binary magic bytes detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `binary-detection-${Date.now()}`);
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

  // -------------------------------------------------------------------------
  // 1. Binary signatures → clear failure message + unsupported status
  // -------------------------------------------------------------------------

  describe("binary files with no extension are rejected", () => {
    for (const { label, format, bytes } of SIGNATURES) {
      it(`should write a failure message for ${label} files (no extension)`, async () => {
        const paths = makePaths();
        const filePath = join(tmpDir, `binary-${format}`);
        writeFileSync(filePath, makeMagicBytes([...bytes]));

        const pi = mockPi();
        const result = await captureFile(pi as never, paths, filePath);

        const extracted = readFile(join(result.packetPath, "extracted.md"));
        expect(extracted).toContain("Binary file could not be converted to markdown");
        expect(extracted).toContain(`detected format: ${format}`);
        expect(extracted).not.toContain("\u0000"); // no raw binary bytes

        const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
        expect(manifest.extraction_status).toBe("unsupported");
        expect(manifest.extractor).toBe("magicBytes");
      });
    }
  });

  describe("binary files with unrecognised extension are rejected", () => {
    for (const { label, format, bytes } of SIGNATURES) {
      it(`should write a failure message for ${label} with a .bin extension`, async () => {
        const paths = makePaths();
        const filePath = join(tmpDir, "data.bin");
        writeFileSync(filePath, makeMagicBytes([...bytes]));

        const pi = mockPi();
        const result = await captureFile(pi as never, paths, filePath);

        const extracted = readFile(join(result.packetPath, "extracted.md"));
        expect(extracted).toContain("Binary file could not be converted to markdown");
        expect(extracted).toContain(`detected format: ${format}`);

        const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
        expect(manifest.extraction_status).toBe("unsupported");
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Failure message format
  // -------------------------------------------------------------------------

  it("failure message should include a hint to use a text-based alternative", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "image");
    writeFileSync(filePath, makeMagicBytes([0x89, 0x50, 0x4e, 0x47])); // PNG

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("Capture a text-based version");
  });

  it("manifest format should remain 'file' for unrecognised binary files", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "mystery");
    writeFileSync(filePath, makeMagicBytes([0x7f, 0x45, 0x4c, 0x46])); // ELF

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("file");
    expect(manifest.extraction_status).toBe("unsupported");
    expect(manifest.extractor).toBe("magicBytes");
  });

  // -------------------------------------------------------------------------
  // 3. Plain text files still work
  // -------------------------------------------------------------------------

  it("should capture a plain text file with no extension successfully", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "plaintext");
    writeFileSync(filePath, "This is plain text content.\nSecond line.", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("This is plain text content.");
    expect(extracted).toContain("Second line.");
    expect(extracted).not.toContain("Binary file could not be converted");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.extractor).toBe("passthrough");
  });

  it("should capture a plain text file with an unrecognised extension successfully", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "app.config");
    writeFileSync(filePath, "key=value\ndebug=true\n", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("key=value");
    expect(extracted).toContain("debug=true");
    expect(extracted).not.toContain("Binary file could not be converted");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.extraction_status).toBe("success");
  });

  it("should capture a YAML-like text file with an unrecognised extension successfully", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "setup.env");
    writeFileSync(filePath, "NODE_ENV=production\nPORT=3000\n", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("NODE_ENV=production");
    expect(extracted).not.toContain("Binary file could not be converted");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.extraction_status).toBe("success");
  });

  // -------------------------------------------------------------------------
  // 4. Named extractors are NOT intercepted by the binary guard
  // -------------------------------------------------------------------------

  it("should NOT intercept .md files — passthrough extractor runs as before", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "notes.md");
    writeFileSync(filePath, "# Hello\n\nSome markdown.", "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("# Hello");
    expect(extracted).not.toContain("Binary file could not be converted");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("markdown");
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.extractor).toBe("passthrough");
  });

  it("should NOT intercept .json files — jsonToMarkdown extractor runs as before", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath, JSON.stringify({ title: "Test", value: 42 }), "utf-8");

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("# Test");
    expect(extracted).not.toContain("Binary file could not be converted");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("json");
    expect(manifest.extractor).toBe("jsonToMarkdown");
    expect(manifest.extraction_status).toBe("success");
  });

  it("should NOT intercept .xml files — xmlToMarkdown extractor runs as before", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "feed.xml");
    writeFileSync(
      filePath,
      `<?xml version="1.0"?><root><title>XML Feed</title><body>Content</body></root>`,
      "utf-8",
    );

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const extracted = readFile(join(result.packetPath, "extracted.md"));
    expect(extracted).toContain("XML Feed");
    expect(extracted).not.toContain("Binary file could not be converted");

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("xml");
    expect(manifest.extractor).toBe("xmlToMarkdown");
  });

  it("should NOT intercept .pdf files — markitdown extractor runs as before (failure path)", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "report.pdf");
    // Real PDF magic bytes — but we want to confirm the .pdf extractor handles it, not magic bytes
    writeFileSync(filePath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]));

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("pdf");
    // Extractor should be "markitdown", not "magicBytes"
    expect(manifest.extractor).toBe("markitdown");
    expect(manifest.extraction_status).toBe("failed"); // MarkItDown unavailable in test env
  });

  it("should NOT intercept .docx files — markitdown extractor runs as before (failure path)", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "doc.docx");
    // DOCX starts with PK (ZIP) magic bytes — guard must NOT fire for named extractors
    writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.format).toBe("docx");
    expect(manifest.extractor).toBe("markitdown");
    // Must NOT be "unsupported" — failure is expected here, but from the docx extractor
    expect(manifest.extraction_status).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // 5. Source page is still written even for unsupported binaries
  // -------------------------------------------------------------------------

  it("should still create a source page skeleton for unsupported binary files", async () => {
    const paths = makePaths();
    const filePath = join(tmpDir, "photo");
    writeFileSync(filePath, makeMagicBytes([0x89, 0x50, 0x4e, 0x47])); // PNG

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, filePath);

    const sourcePage = readFile(result.sourcePagePath);
    expect(sourcePage).toContain("type: source");
    expect(sourcePage).toContain(result.sourceId);
    expect(sourcePage).toContain("## Summary");
    expect(sourcePage).toContain("## Key Takeaways");
  });
});
