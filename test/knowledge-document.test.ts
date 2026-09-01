import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeDocument,
  FRONTMATTER_MAX_BYTES,
  parseKnowledgeDocument,
  patchKnowledgeDocument,
  readKnowledgeDocumentFile,
  serializeKnowledgeDocument,
  writeKnowledgeDocumentFile,
} from "../extensions/llm-wiki/lib/knowledge-document.js";

function parsed(content: string, path = "concepts/test.md") {
  const result = parseKnowledgeDocument(content, path);
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error("expected parsed document");
  return result.document;
}

describe("KnowledgeDocument", () => {
  it("parses nested OKF values, timestamps as strings, and unknown mappings", () => {
    const input = readFileSync(
      join(import.meta.dirname, "fixtures/okf/documents/nested.md"),
      "utf8",
    );
    const doc = parsed(input, "analyses/revenue-total.md");
    expect(doc.id).toBe("analyses/revenue-total");
    expect(doc.frontmatter.generated).toEqual({
      by: "pi-llm-wiki/model",
      at: "2026-08-02T10:00:00Z",
    });
    expect(typeof (doc.frontmatter.generated as Record<string, unknown>).at).toBe("string");
    expect(doc.extensions.producer_data).toEqual({
      nested: { enabled: true, weights: [1, 2, 3] },
    });
    expect(doc.sources.kind).toBe("canonical");
  });

  it("round-trips unknown values and exact body separator rules", () => {
    const doc = parsed("---\ntype: concept\nunknown: {empty: [], map: {}}\n---\n\n\nFirst\n");
    const output = serializeKnowledgeDocument(doc);
    expect(output).toBe("---\ntype: concept\nunknown:\n  empty: []\n  map: {}\n---\n\n\nFirst\n");
    const again = parsed(output);
    expect(again.extensions.unknown).toEqual({ empty: [], map: {} });
    expect(again.body).toBe("\nFirst\n");
  });

  it("emits no separator blank line for an empty body", () => {
    const doc = createKnowledgeDocument("concepts/empty.md", { type: "concept" }, "");
    expect(serializeKnowledgeDocument(doc)).toBe("---\ntype: concept\n---\n");
  });

  it("accepts CRLF and emits LF with one final newline", () => {
    const doc = parsed("---\r\ntype: concept\r\n---\r\n\r\nBody\r\n");
    expect(serializeKnowledgeDocument(doc)).toBe("---\ntype: concept\n---\n\nBody\n");
  });

  it("escapes aliased wikilinks in generated Markdown without changing fenced code", () => {
    const doc = createKnowledgeDocument(
      "concepts/table.md",
      { type: "concept" },
      "| Name |\n| --- |\n| [[entities/gildan|Gildan]] |\n\n```md\n[[entities/raw|Raw]]\n```",
    );
    expect(doc.body).toContain("[[entities/gildan\\|Gildan]]");
    expect(doc.body).toContain("[[entities/raw|Raw]]");
  });

  it.each([
    ["frontmatter_duplicate_key", "---\ntype: concept\ntype: entity\n---\n"],
    ["frontmatter_alias_forbidden", "---\ntype: concept\nx: &x [1]\ny: *x\n---\n"],
    ["frontmatter_custom_tag_forbidden", "---\ntype: concept\nx: !producer value\n---\n"],
    ["frontmatter_multiple_documents", "---\ntype: concept\n...\n---\ntype: entity\n---\n"],
  ])("returns %s without exposing a YAML exception", (code, input) => {
    const result = parseKnowledgeDocument(input, "concepts/bad.md");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(code);
    expect(result.diagnostics[0].path).toBe("concepts/bad.md");
  });

  it.each([
    ["frontmatter_parse_error", "---\ntype: concept\nx: [1,\n---\n"],
    ["frontmatter_duplicate_key", "---\ntype: concept\nx:\n  a: 1\n  a: 2\n---\n"],
    ["frontmatter_duplicate_key", '---\ntype: concept\ntrue: one\n"true": two\n---\n'],
    ["frontmatter_missing", "---oops\ntype: concept\n---\n"],
    ["concept_missing_type", "---\ntype: 42\n---\n"],
    ["concept_missing_type", "---\ntype: []\n---\n"],
  ])("rejects adversarial input with %s", (code, input) => {
    const result = parseKnowledgeDocument(input, "concepts/adversarial.md");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it("preserves null and prototype-named unknown fields semantically", () => {
    const input = [
      "---",
      "type: concept",
      "nullable: null",
      "__proto__:",
      "  enabled: true",
      "constructor:",
      "  nested: value",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const first = parsed(input);
    expect(first.extensions.nullable).toBeNull();
    expect(Object.hasOwn(first.extensions, "__proto__")).toBe(true);
    expect(first.extensions.__proto__).toEqual({ enabled: true });
    const second = parsed(serializeKnowledgeDocument(first));
    expect(second.extensions).toEqual(first.extensions);
  });

  it("preserves explicit null sources as an unknown shape", () => {
    const doc = parsed("---\ntype: concept\nsources: null\n---\n");
    expect(doc.sources).toEqual({ kind: "unknown-shape", value: null });
    expect(parsed(serializeKnowledgeDocument(doc)).sources).toEqual(doc.sources);
  });

  it("rejects sources passed through creation fields instead of the canonical argument", () => {
    expect(() =>
      createKnowledgeDocument(
        "concepts/bad.md",
        { type: "concept", sources: [] } as never,
        "Body.",
      ),
    ).toThrow("Pass canonical sources as the fourth argument");
  });

  it("rejects missing frontmatter, missing type, byte overflow, and depth overflow", () => {
    expect(parseKnowledgeDocument("# Body\n", "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_missing",
    );
    expect(
      parseKnowledgeDocument("---\ntitle: A\n---\n", "concepts/a.md").diagnostics[0].code,
    ).toBe("concept_missing_type");
    const large = `---\ntype: concept\nx: ${"a".repeat(FRONTMATTER_MAX_BYTES)}\n---\n`;
    expect(parseKnowledgeDocument(large, "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_limit_bytes",
    );
    const deep = `---\ntype: concept\nx: ${"[".repeat(33)}0${"]".repeat(33)}\n---\n`;
    expect(parseKnowledgeDocument(deep, "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_limit_depth",
    );
  });

  it("limits nesting in explicit YAML mapping keys", () => {
    const key = `${"[".repeat(33)}0${"]".repeat(33)}`;
    const result = parseKnowledgeDocument(
      `---\ntype: concept\n? ${key}\n: value\n---\n`,
      "concepts/deep-key.md",
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "frontmatter_limit_depth",
    );
  });

  it("reads and writes canonical document files", () => {
    const path = join(import.meta.dirname, "..", "tmp", "knowledge-document-file.md");
    const doc = createKnowledgeDocument(path, { type: "concept", title: "File" }, "Body.");
    try {
      writeKnowledgeDocumentFile(path, doc);
      const result = readKnowledgeDocumentFile(path, path);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it.each([
    ["legacy-scalar", "sources: sources/SRC-1"],
    ["legacy-list", "sources: [sources/SRC-1, sources/SRC-2]"],
  ])("preserves %s sources during an ordinary patch", (_kind, sourceLine) => {
    const doc = parsed(`---\ntype: source\n${sourceLine}\nproducer: {keep: true}\n---\n\nOld\n`);
    const patched = patchKnowledgeDocument(doc, { fields: { status: "ingested" }, body: "New\n" });
    const reparsed = parsed(serializeKnowledgeDocument(patched));
    expect(reparsed.sources).toEqual(doc.sources);
    expect(reparsed.extensions.producer).toEqual({ keep: true });
    expect(reparsed.body).toBe("New\n");
  });
});
