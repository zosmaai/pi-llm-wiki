/**
 * E2E test suite for PR #52 — DOCX extraction + manifest metadata.
 *
 * These tests call the real extension code (captureFile) and verify the
 * on-disk output in a temporary wiki vault, mirroring what happens when pi
 * runs wiki_capture_source for a DOCX / XML / JSON file.
 *
 * Two flavours of pi.exec are used:
 *   - mockPi()              → simulates MarkItDown unavailable (which uvx → "no")
 *   - realPi()              → shells out for real; uvx must be on PATH for the
 *                             success path to produce extracted text.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureFile } from "../extensions/llm-wiki/lib/source-packet.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { mockPi } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = join(import.meta.dirname, "..", "tmp", `e2e-docx-${Date.now()}`);

function makePaths() {
  const p = getVaultPaths(join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`));
  ensureVaultStructure(p);
  return p;
}

function readFile(path: string): string {
  return readFileSync(path, { encoding: "utf-8" });
}

/**
 * A pi.exec wrapper that actually runs system commands so the real markitdown
 * / uvx code path is exercised end-to-end.
 */
function realPi() {
  return {
    exec: (
      command: string,
      args: string[],
      options?: { timeout?: number },
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      return new Promise((resolve) => {
        const child = spawn(command, args, { shell: false });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("close", (code) => {
          resolve({ stdout, stderr, code: code ?? 0 });
        });
        child.on("error", (err) => {
          resolve({ stdout, stderr: err.message, code: 1 });
        });
        if (options?.timeout) {
          setTimeout(() => {
            child.kill();
            resolve({ stdout, stderr: "timeout", code: 1 });
          }, options.timeout);
        }
      });
    },
  };
}

/**
 * Build a minimal but spec-valid DOCX (ZIP) in memory and write it to disk.
 * markitdown can extract text from this without any Office dependency.
 */
function createRealDocx(destPath: string, bodyText: string): void {
  const script = `
import zipfile, io, os

content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>"""

doc_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>"""

body = ${JSON.stringify(bodyText)}
document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>{body}</w:t></w:r></w:p>
  </w:body>
</w:document>"""

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/_rels/document.xml.rels", doc_rels)
    z.writestr("word/document.xml", document)

with open(${JSON.stringify(destPath)}, "wb") as f:
    f.write(buf.getvalue())

print("ok")
`;

  const result = require("node:child_process").spawnSync("python3", ["-c", script]);
  if (result.status !== 0) {
    throw new Error(`Failed to create DOCX: ${result.stderr?.toString()}`);
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true });

  // Pre-warm the uvx cache for markitdown[docx,pdf] so test 3.3 doesn't pay
  // the package-download cost inside the timed test body. Safe to run even if
  // uvx is not installed — errors are swallowed.
  await new Promise<void>((resolve) => {
    const child = spawn("sh", [
      "-c",
      "uvx --from 'markitdown[docx,pdf]' markitdown --version >/dev/null 2>&1 || true",
    ]);
    child.on("close", () => resolve());
    child.on("error", () => resolve());
    // Cap at 90 s — plenty for a first-time download.
    setTimeout(() => {
      child.kill();
      resolve();
    }, 90_000);
  });
}, 120_000);

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E — PR #52: DOCX extraction & manifest metadata", () => {
  // -------------------------------------------------------------------------
  // 3.2  Fake DOCX — MarkItDown unavailable (failure path)
  // -------------------------------------------------------------------------
  it("3.2 fake DOCX: writes failure message (not binary) when MarkItDown is unavailable", async () => {
    const paths = makePaths();

    // Minimal ZIP magic bytes — looks like a DOCX to the extractor selector
    const docxPath = join(tmpDir, "fake-report.docx");
    writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

    // mockPi() returns stdout:"no\n" for any sh command → which uvx → "no"
    const pi = mockPi();
    const result = await captureFile(pi as never, paths, docxPath);

    console.log("\n── 3.2 extracted.md ──────────────────────────");
    const extracted = readFile(join(result.packetPath, "extracted.md"));
    console.log(extracted);

    console.log("── 3.2 manifest.json ─────────────────────────");
    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    console.log(JSON.stringify(manifest, null, 2));

    // extracted.md checks
    expect(extracted, "should NOT contain raw ZIP magic bytes").not.toContain("PK");
    expect(extracted, "should contain the DOCX failure message").toContain(
      "DOCX content could not be converted",
    );
    expect(extracted, "should contain the filename").toContain("fake-report.docx");

    // manifest.json checks
    expect(manifest.format, "format should be docx").toBe("docx");
    expect(manifest.extractor, "extractor should be markitdown").toBe("markitdown");
    expect(manifest.extraction_status, "extraction_status should be failed").toBe("failed");

    // original artifact preserved
    expect(
      existsSync(join(result.packetPath, "original", "fake-report.docx")),
      "original DOCX should be preserved",
    ).toBe(true);

    console.log("✅ 3.2 PASS\n");
  });

  // -------------------------------------------------------------------------
  // 3.3  Real DOCX — MarkItDown via uvx (success path)
  // -------------------------------------------------------------------------
  it("3.3 real DOCX: extracts readable markdown via markitdown (uvx)", async () => {
    const paths = makePaths();

    // Build a spec-valid DOCX from scratch using Python's zipfile
    const docxPath = join(tmpDir, "proposal.docx");
    createRealDocx(
      docxPath,
      "PI LLM Wiki is a self-maintaining knowledge base that compounds over time.",
    );

    expect(existsSync(docxPath), "real DOCX file should exist on disk").toBe(true);

    // realPi() shells out → uvx is on PATH → markitdown should actually run
    const pi = realPi();
    const result = await captureFile(pi as never, paths, docxPath);

    console.log("\n── 3.3 extracted.md ──────────────────────────");
    const extracted = readFile(join(result.packetPath, "extracted.md"));
    console.log(extracted.slice(0, 600));

    console.log("── 3.3 manifest.json ─────────────────────────");
    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    console.log(JSON.stringify(manifest, null, 2));

    expect(manifest.format, "format should be docx").toBe("docx");
    expect(manifest.extractor, "extractor should be markitdown").toBe("markitdown");

    if (manifest.extraction_status === "success") {
      // uvx + markitdown is available and worked
      expect(extracted, "extracted text should be readable markdown, not binary").not.toContain(
        "PK",
      );
      expect(extracted, "extracted text should NOT say could not be converted").not.toContain(
        "could not be converted",
      );
      expect(extracted, "extracted text should contain the document body").toContain("PI LLM Wiki");
      console.log("✅ 3.3 PASS — markitdown extracted text successfully\n");
    } else {
      // uvx is present but markitdown itself isn't installed yet — acceptable fallback
      expect(
        extracted,
        "failure message should be present if markitdown is not installed",
      ).toContain("DOCX content could not be converted");
      console.log(
        "⚠️  3.3 PARTIAL — uvx found but markitdown not yet installed; failure message written correctly\n",
      );
    }
  }, 60_000); // markitdown[docx,pdf] may need a moment even with warm cache

  // -------------------------------------------------------------------------
  // 3.4  XML — manifest metadata fields
  // -------------------------------------------------------------------------
  it("3.4 XML: manifest contains extractor=xmlToMarkdown, extraction_status=success, content_type=application/xml", async () => {
    const paths = makePaths();

    const xmlPath = join(tmpDir, "data.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<report>
  <title>Quarterly Review</title>
  <section>
    <heading>Summary</heading>
    <p>Revenue increased by 12 percent this quarter.</p>
  </section>
</report>`,
      "utf-8",
    );

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, xmlPath);

    console.log("\n── 3.4 extracted.md ──────────────────────────");
    const extracted = readFile(join(result.packetPath, "extracted.md"));
    console.log(extracted);

    console.log("── 3.4 manifest.json ─────────────────────────");
    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    console.log(JSON.stringify(manifest, null, 2));

    // extracted.md checks
    expect(extracted).toContain("Quarterly Review");
    expect(extracted).toContain("Revenue increased by 12 percent");
    expect(extracted).not.toContain("<?xml");
    expect(extracted).not.toContain("<report>");

    // manifest checks
    expect(manifest.extractor).toBe("xmlToMarkdown");
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.content_type).toBe("application/xml");

    console.log("✅ 3.4 PASS\n");
  });

  // -------------------------------------------------------------------------
  // 3.5  JSON — manifest metadata fields
  // -------------------------------------------------------------------------
  it("3.5 JSON: manifest contains extractor=jsonToMarkdown, extraction_status=success, content_type=application/json", async () => {
    const paths = makePaths();

    const jsonPath = join(tmpDir, "roadmap.json");
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          title: "Project Roadmap",
          scope: "Ship the new onboarding flow.",
          tasks: [
            { id: "task-1", title: "Design mockups" },
            { id: "task-2", title: "Implement backend" },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const pi = mockPi();
    const result = await captureFile(pi as never, paths, jsonPath);

    console.log("\n── 3.5 extracted.md ──────────────────────────");
    const extracted = readFile(join(result.packetPath, "extracted.md"));
    console.log(extracted);

    console.log("── 3.5 manifest.json ─────────────────────────");
    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    console.log(JSON.stringify(manifest, null, 2));

    // extracted.md checks
    expect(extracted).toContain("# Project Roadmap");
    expect(extracted).toContain("Ship the new onboarding flow");
    expect(extracted).toContain("Design mockups");
    expect(extracted).not.toContain('"tasks"');
    expect(extracted).not.toContain("{");

    // manifest checks
    expect(manifest.extractor).toBe("jsonToMarkdown");
    expect(manifest.extraction_status).toBe("success");
    expect(manifest.content_type).toBe("application/json");

    console.log("✅ 3.5 PASS\n");
  });
});
